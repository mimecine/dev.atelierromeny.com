// Replaces the camera files in a matcher folder with much smaller WebP copies, one at a
// time (so it works on a nearly full disk), and renames them in matches.json.
// Files are kept at up to --max px (default 3000, same as apply.ts) so apply still has
// full-quality sources. The originals are deleted: only use this with a copy elsewhere.
//
//   bun scripts/photo-matcher/to-webp.ts <photo-folder> [--max 3000] [--quality 90]
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { loadState, statePath } from "./lib";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return Number(i >= 0 ? args[i + 1] : fallback);
};
const dir = path.resolve(args[0] ?? "");
const maxEdge = flag("--max", "3000");
const quality = flag("--quality", "90");
const CONVERT = [".tif", ".tiff", ".heic", ".png", ".jpg", ".jpeg"];

const files = fs
  .readdirSync(dir)
  .filter((f) => !f.startsWith(".") && CONVERT.includes(path.extname(f).toLowerCase()));

const renamed = new Map<string, string>();
let before = 0, after = 0;
for (const [i, f] of files.entries()) {
  const src = path.join(dir, f);
  const name = f.replace(/\.[^.]+$/, ".webp");
  const out = path.join(dir, name);
  if (fs.existsSync(out)) {
    console.error(`skip ${f}: ${name} already exists`);
    continue;
  }
  const tmp = `${out}.part`;
  await sharp(src)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toFile(tmp);
  await sharp(tmp).metadata(); // throws if the output is unreadable, before we delete anything
  before += fs.statSync(src).size;
  after += fs.statSync(tmp).size;
  fs.renameSync(tmp, out);
  fs.unlinkSync(src);
  renamed.set(f, name);
  console.log(`${i + 1}/${files.length} ${f} -> ${name}`);
}

const state = loadState(dir);
if (state) {
  // Also catches files converted by an earlier, interrupted run.
  const rename = (p: string) => {
    const webp = p.replace(/\.[^.]+$/, ".webp");
    return !fs.existsSync(path.join(dir, p)) && fs.existsSync(path.join(dir, webp)) ? webp : p;
  };
  state.assignments = state.assignments.map((a) => ({ ...a, photo: rename(a.photo) }));
  state.skippedPhotos = state.skippedPhotos.map(rename);
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
console.log(`\n${renamed.size} files: ${mb(before)} -> ${mb(after)}`);
