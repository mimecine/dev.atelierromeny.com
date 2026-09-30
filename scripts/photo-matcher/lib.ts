import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export const ROOT = path.resolve(import.meta.dir, "../..");
export const WORKS_DIR = path.join(ROOT, "src/content/works");
export const COLLECTIONS_DIR = path.join(ROOT, "src/content/collections");
export const MEDIA_DIR = path.join(ROOT, "src/media/works");

export const PHOTO_EXTS = [".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".webp"];

export type Work = {
  file: string; // absolute path of the markdown file
  slug: string; // markdown basename without .md
  data: Record<string, any>;
  content: string;
};

export type Target = string; // numeric work id as string, or "new:<n>" for works without an id

export type State = {
  ids: number[];
  idPos: number;
  photoPos: number;
  // In order of assignment: the first photo for a target becomes `image`, the rest `images`.
  assignments: { photo: string; target: Target }[];
  skippedPhotos: string[];
  skippedIds: number[];
  newCount: number;
  lastTarget: Target | null;
  rev?: number; // bumped on every save, so a stale browser tab can't overwrite newer progress
};

export function loadWorks(): Work[] {
  return fs
    .readdirSync(WORKS_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => {
      const file = path.join(WORKS_DIR, f);
      const { data, content } = matter(fs.readFileSync(file, "utf-8"));
      return { file, slug: f.replace(/\.md$/, ""), data, content };
    });
}

export function worksById(works: Work[]) {
  const map = new Map<number, Work[]>();
  for (const w of works) {
    const id = Number(w.data.id);
    if (w.data.id == null || Number.isNaN(id)) continue;
    map.set(id, [...(map.get(id) ?? []), w]);
  }
  return map;
}

/** "/src/media/works/foo.jpg" (or old "@img/foo.jpg") -> absolute path in src/media/works */
export function mediaPath(ref: string | null | undefined) {
  if (!ref) return null;
  return path.join(MEDIA_DIR, path.basename(ref));
}

export function slugify(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function listPhotos(dir: string) {
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith(".") && PHOTO_EXTS.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Pulls the first integer from each line, so "351", "351, L'été" and "#351" all work. */
export function parseIds(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/\d+/)?.[0])
    .filter((m): m is string => !!m)
    .map(Number);
}

export function statePath(photoDir: string) {
  return path.join(photoDir, "matches.json");
}

export function loadState(photoDir: string): State | null {
  const p = statePath(photoDir);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
}

/** Writes a WebP copy of `src`, shrunk (never enlarged) so its long edge is at most `maxEdge`. */
export async function toWebp(src: string, dest: string, maxEdge: number, quality = 88) {
  const { default: sharp } = await import("sharp");
  await sharp(src)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toFile(dest);
}

/** Writes a JPEG copy of `src`, shrunk (never enlarged) so its long edge is at most `maxEdge`. */
export async function toJpeg(src: string, dest: string, maxEdge: number, quality = 88) {
  const info = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", src]).stdout.toString();
  const long = Math.max(...[...info.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
  const resize = long > maxEdge ? ["-Z", String(maxEdge)] : [];
  const proc = Bun.spawn(
    ["sips", ...resize, "-s", "format", "jpeg", "-s", "formatOptions", String(quality), src, "--out", dest],
    { stdout: "ignore", stderr: "pipe" }
  );
  if ((await proc.exited) !== 0) throw new Error(`sips failed for ${src}: ${await new Response(proc.stderr).text()}`);
}
