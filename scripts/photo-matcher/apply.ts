// Applies <photo-folder>/matches.json made with server.ts:
//  - copies each photo into src/media/works as <id>-<title>.webp (extras get -2, -3, …),
//    resized so the long edge is at most --max px (default 3000)
//  - sets `image` / `images` on the matching work; its previous `image` moves to `old_image`
//    (never overwritten), so the old photo stays available in the CMS
//  - adds works matched by id to --paintings-collection (default "new-paintings")
//  - creates untitled works (collection --collection, default "prints") for "new work" photos
//  Both collections are created, unpublished, if they don't exist yet.
//
//   bun scripts/photo-matcher/apply.ts <photo-folder>            # dry run
//   bun scripts/photo-matcher/apply.ts <photo-folder> --write    # do it
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { v4 as uuid } from "uuid";
import {
  COLLECTIONS_DIR,
  MEDIA_DIR,
  WORKS_DIR,
  type Target,
  type Work,
  loadState,
  loadWorks,
  mediaPath,
  slugify,
  toWebp,
  worksById,
} from "./lib";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const photoDir = path.resolve(args[0] ?? "");
const write = args.includes("--write");
const maxEdge = Number(flag("--max", "3000"));
const newCollection = flag("--collection", "prints");
const newCategory = flag("--category", "Print");
const paintingsCollection = flag("--paintings-collection", "new-paintings");

const state = loadState(photoDir);
if (!state) {
  console.error(`No matches.json in ${photoDir}`);
  process.exit(1);
}

const allWorks = loadWorks();
const byId = worksById(allWorks);

// Group photos per target, keeping the order they were assigned in.
const groups = new Map<Target, string[]>();
for (const { photo, target } of state.assignments) {
  groups.set(target, [...(groups.get(target) ?? []), photo]);
}

// Media files still referenced by works that this run doesn't touch.
const touched = new Set<string>();
const claimedMedia = new Set<string>();

const mediaFiles = fs.readdirSync(MEDIA_DIR);

const namesFor = (base: string, count: number) =>
  Array.from({ length: count }, (_, i) => (i === 0 ? `${base}.webp` : `${base}-${i + 1}.webp`));

/** A base name whose files don't collide with media we may not overwrite. */
function uniqueBase(base: string, count: number, allowed: Set<string>) {
  let candidate = base;
  for (let n = 2; ; n++) {
    const wanted = new Set(namesFor(candidate, count).map((f) => f.replace(/\.[^.]+$/, "")));
    const clash = mediaFiles.some((f) => wanted.has(f.replace(/\.[^.]+$/, "")) && !allowed.has(f));
    if (!clash && ![...wanted].some((w) => claimedMedia.has(w))) {
      wanted.forEach((w) => claimedMedia.add(w));
      return candidate;
    }
    candidate = `${base}-v${n}`;
  }
}

function uniqueWorkFile(slug: string) {
  let candidate = slug;
  for (let n = 2; fs.existsSync(path.join(WORKS_DIR, `${candidate}.md`)); n++) candidate = `${slug}-${n}`;
  return path.join(WORKS_DIR, `${candidate}.md`);
}

// What earlier --write runs did, so re-running is safe: works created for "new:<n>"
// targets (-> slug) and the media files we wrote (which are never treated as an old image).
const appliedPath = path.join(photoDir, "applied.json");
const applied: { created: Record<Target, string>; written: string[] } = fs.existsSync(appliedPath)
  ? JSON.parse(fs.readFileSync(appliedPath, "utf-8"))
  : { created: {}, written: [] };
const created = applied.created;
// Compared without extension: media may since have been converted (e.g. .jpg -> .webp).
const stem = (f: string) => path.basename(f).replace(/\.[^.]+$/, "");
const written = new Set(applied.written.map(stem));
let newIndex = 0;
const log: string[] = [];
const orphaned: string[] = [];

for (const [target, photos] of groups) {
  let work: Work;
  let base: string;

  if (target.startsWith("new:")) {
    newIndex++;
    const existing = created[target] && allWorks.find((w) => w.slug === created[target]);
    if (existing) {
      work = existing;
    } else {
      let n = newIndex;
      while (fs.existsSync(path.join(WORKS_DIR, `print-${String(n).padStart(3, "0")}.md`))) n++;
      const file = uniqueWorkFile(`print-${String(n).padStart(3, "0")}`);
      work = {
        file,
        slug: path.basename(file, ".md"),
        data: { title: null, categories: newCategory, collections: [newCollection], uuid: uuid() },
        content: "",
      };
      created[target] = work.slug;
    }
    base = work.slug;
    log.push(`${existing ? "SET " : "NEW "} ${work.slug}  <- ${photos.join(", ")}`);
  } else {
    const id = Number(target);
    const found = byId.get(id) ?? [];
    if (found.length > 1) {
      log.push(`SKIP #${id}: ${found.length} works share this id (${found.map((w) => w.slug).join(", ")})`);
      continue;
    }
    work = found[0] ?? {
      file: uniqueWorkFile(String(id)),
      slug: String(id),
      data: { id, title: null, uuid: uuid() },
      content: "",
    };
    base = [id, slugify(work.data.title ?? "")].filter(Boolean).join("-");
    log.push(`${found[0] ? "SET " : "NEW "} #${id} ${work.data.title ?? "(untitled)"}  <- ${photos.join(", ")}`);
    const collections: string[] = work.data.collections ?? [];
    if (!collections.includes(paintingsCollection)) work.data.collections = [...collections, paintingsCollection];
  }

  // Keep the pre-reshoot image. On a re-run `old_image` is already set and the first of
  // `images` is one of ours from the previous run, which may be overwritten. The detail
  // (…-detail.webp, last of `images`) is kept as it is.
  const isDetail = (r: string) => r.endsWith("-detail.webp");
  const current: string[] = (work.data.images ?? []).filter(Boolean);
  const main = current.find((r) => !isDetail(r));
  if (!work.data.old_image && main && !written.has(stem(main))) {
    work.data.old_image = main;
  }
  const keep = work.data.old_image ? path.basename(work.data.old_image) : null;
  const own = new Set(
    current
      .filter((r) => !isDetail(r))
      .filter(Boolean)
      .map((r: string) => path.basename(r))
      .filter((f) => f !== keep)
  );
  base = uniqueBase(base, photos.length, own);

  const names = namesFor(base, photos.length);
  for (const [i, photo] of photos.entries()) {
    log.push(`       ${photo} -> src/media/works/${names[i]}`);
    if (write) await toWebp(path.join(photoDir, photo), path.join(MEDIA_DIR, names[i]), maxEdge);
    written.add(stem(names[i]));
  }

  for (const old of own) if (!names.includes(old)) orphaned.push(old);

  work.data.images = [...names.map((n) => `/src/media/works/${n}`), ...current.filter(isDetail)];
  delete work.data.image;
  touched.add(work.file);

  if (write) fs.writeFileSync(work.file, matter.stringify(work.content, work.data));
}

function ensureCollection(slug: string) {
  if (fs.existsSync(path.join(COLLECTIONS_DIR, `${slug}.md`))) return;
  const title = slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  log.push(`NEW  collection ${slug} "${title}" (unpublished)`);
  if (write) {
    fs.writeFileSync(
      path.join(COLLECTIONS_DIR, `${slug}.md`),
      matter.stringify("", { title, published: false, inmenu: false, uuid: uuid() })
    );
  }
}
if (newIndex) ensureCollection(newCollection);
if ([...groups.keys()].some((t) => !t.startsWith("new:"))) ensureCollection(paintingsCollection);

if (write) fs.writeFileSync(appliedPath, JSON.stringify({ created, written: [...written] }, null, 2));

// Old images no longer referenced by any work.
const stillUsed = new Set(
  allWorks
    .filter((w) => !touched.has(w.file))
    .flatMap((w) => [w.data.old_image, w.data.file, ...(w.data.images ?? [])])
    .filter(Boolean)
    .map((r: string) => path.basename(r))
);
const unused = [...new Set(orphaned)].filter((f) => !stillUsed.has(f) && fs.existsSync(mediaPath(f)!));

console.log(log.join("\n"));
console.log(`\n${groups.size} works, ${state.assignments.length} photos, ${state.skippedPhotos.length} photos skipped.`);
if (unused.length) {
  console.log(`\n${unused.length} old images are no longer used (left in place, delete when happy):`);
  for (const f of unused) console.log(`  src/media/works/${f}`);
}
console.log(write ? "\nDone." : "\nDry run. Re-run with --write to apply.");
