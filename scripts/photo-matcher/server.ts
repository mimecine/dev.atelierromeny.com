// Local tool for matching newly shot photos to existing works.
//
//   bun scripts/photo-matcher/server.ts <photo-folder> [id-list.txt]
//
// Progress is saved continuously to <photo-folder>/matches.json; the id list is
// only needed on the first run. When done, run apply.ts to copy the photos into
// src/media/works and update the markdown.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ROOT,
  MEDIA_DIR,
  type State,
  listPhotos,
  loadState,
  loadWorks,
  parseIds,
  statePath,
  toJpeg,
  worksById,
} from "./lib";

const [photoArg, idsArg] = process.argv.slice(2);
if (!photoArg) {
  console.error("Usage: bun scripts/photo-matcher/server.ts <photo-folder> [id-list.txt]");
  process.exit(1);
}
const photoDir = path.resolve(photoArg);
const previewDir = path.join(ROOT, "node_modules/.cache/photo-matcher");
fs.mkdirSync(previewDir, { recursive: true });

let state = loadState(photoDir);
if (idsArg) {
  const ids = parseIds(fs.readFileSync(path.resolve(idsArg), "utf-8"));
  if (!state) {
    state = {
      ids,
      idPos: 0,
      photoPos: 0,
      assignments: [],
      skippedPhotos: [],
      skippedIds: [],
      newCount: 0,
      lastTarget: null,
    };
  } else if (JSON.stringify(ids) !== JSON.stringify(state.ids)) {
    console.warn("Note: matches.json exists; keeping its id list and ignoring", idsArg);
  }
}
if (!state) {
  console.error("No matches.json in the photo folder yet, so an id list file is required.");
  process.exit(1);
}
fs.writeFileSync(statePath(photoDir), JSON.stringify(state, null, 2));

const photos = listPhotos(photoDir);
const works = worksById(loadWorks());

function workInfo(id: number) {
  const matches = works.get(id) ?? [];
  return matches.map((w) => ({
    slug: w.slug,
    title: w.data.title ?? null,
    year: w.data.year ?? w.data.year_start ?? null,
    w: w.data.w ?? null,
    h: w.data.h ?? null,
    location: w.data.new_location ?? w.data.location ?? null,
    image: w.data.image ? path.basename(w.data.image) : null,
    images: (w.data.images ?? []).map((i: string) => path.basename(i)),
  }));
}

// Camera files can be huge (or HEIC/TIFF), so the browser gets cached JPEGs:
// 1600px for the big views, 400px for the grids.
const SIZES = { large: 1600, thumb: 400 } as const;
const pending = new Map<string, Promise<string>>();
let running = 0;
const queue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>) {
  if (running >= 4) await new Promise<void>((resolve) => queue.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

function cached(src: string, size: keyof typeof SIZES): Promise<string> {
  const stat = fs.statSync(src);
  const id = `${src}:${stat.size}:${stat.mtimeMs}` + (size === "large" ? "" : `:${size}`);
  const key = createHash("sha1").update(id).digest("hex");
  const out = path.join(previewDir, `${key}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!pending.has(out)) {
    const job = (async () => {
      // Thumbnails of camera files are made from the large preview, which is much quicker to read.
      const from = size === "thumb" && src.startsWith(photoDir) ? await cached(src, "large") : src;
      await limited(() => toJpeg(from, out, SIZES[size], 80));
      return out;
    })().finally(() => pending.delete(out));
    pending.set(out, job);
  }
  return pending.get(out)!;
}

function sizeParam(url: URL): keyof typeof SIZES {
  return url.searchParams.get("size") === "thumb" ? "thumb" : "large";
}

function safeJoin(dir: string, name: string) {
  const p = path.join(dir, path.basename(decodeURIComponent(name)));
  return fs.existsSync(p) ? p : null;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4455),
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/") return new Response(Bun.file(path.join(import.meta.dir, "index.html")));

    if (p === "/api/init") {
      const info: Record<number, ReturnType<typeof workInfo>> = {};
      for (const id of state!.ids) info[id] = workInfo(id);
      return Response.json({ photoDir, photos, state, works: info });
    }

    if (p === "/api/work") {
      const id = Number(url.searchParams.get("id"));
      return Response.json(workInfo(id));
    }

    if (p === "/api/state" && req.method === "PUT") {
      const next = (await req.json()) as State;
      if ((next.rev ?? 0) !== (state!.rev ?? 0)) return new Response("stale", { status: 409 });
      state = { ...next, rev: (next.rev ?? 0) + 1 };
      fs.writeFileSync(statePath(photoDir), JSON.stringify(state, null, 2));
      return Response.json({ rev: state.rev });
    }

    if (p.startsWith("/old/")) {
      const file = safeJoin(MEDIA_DIR, p.slice(5));
      if (!file) return new Response("not found", { status: 404 });
      return new Response(Bun.file(sizeParam(url) === "thumb" ? await cached(file, "thumb") : file));
    }

    if (p.startsWith("/photo/")) {
      const name = path.basename(decodeURIComponent(p.slice(7)));
      if (!photos.includes(name)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(await cached(path.join(photoDir, name), sizeParam(url))), {
        headers: { "Cache-Control": "max-age=86400" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`${photos.length} photos, ${state.ids.length} ids`);
console.log(`Photo matcher running at http://localhost:${server.port}`);
if (!process.env.NO_OPEN) Bun.spawn(["open", `http://localhost:${server.port}`]);
