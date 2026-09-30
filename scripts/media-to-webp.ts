// Converts src/media/img to WebP (same pixel size) and rewrites @img/ references in
// src/content. One file at a time, original deleted after the copy checks out; safe to
// re-run after an interruption (references are fixed up for any file already converted).
//
//   bun scripts/media-to-webp.ts            # dry run
//   bun scripts/media-to-webp.ts --write
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dir, "..");
const MEDIA = path.join(ROOT, "src/media/img");
const CONTENT = path.join(ROOT, "src/content");
const write = process.argv.includes("--write");
const quality = 90;

const toWebpName = (f: string) => f.replace(/\.(jpe?g|png)$/i, ".webp");
const files = fs.readdirSync(MEDIA).filter((f) => /\.(jpe?g|png)$/i.test(f));

let before = 0, after = 0, converted = 0;
for (const [i, f] of files.entries()) {
  const src = path.join(MEDIA, f);
  const out = path.join(MEDIA, toWebpName(f));
  if (fs.existsSync(out)) {
    console.error(`skip ${f}: ${toWebpName(f)} already exists`);
    continue;
  }
  before += fs.statSync(src).size;
  if (!write) continue;
  const tmp = `${out}.part`;
  await sharp(src).rotate().webp({ quality }).toFile(tmp);
  await sharp(tmp).metadata(); // throws if unreadable, before the original is deleted
  after += fs.statSync(tmp).size;
  fs.renameSync(tmp, out);
  fs.unlinkSync(src);
  converted++;
  if (converted % 25 === 0) console.log(`${i + 1}/${files.length}`);
}

// Point references at the .webp wherever the original is gone and the WebP exists.
const REF = /@img\/([^'"\s)\]]+\.(?:jpe?g|png))/gi;
let refs = 0, refFiles = 0;
function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(md|ya?ml|json)$/.test(entry.name)) {
      const text = fs.readFileSync(p, "utf-8");
      let n = 0;
      const next = text.replace(REF, (whole, name) => {
        const webp = toWebpName(name);
        const done = !fs.existsSync(path.join(MEDIA, name)) && fs.existsSync(path.join(MEDIA, webp));
        const willBe = !write && files.includes(name);
        if (!done && !willBe) return whole;
        n++;
        return `@img/${webp}`;
      });
      if (n) {
        refs += n;
        refFiles++;
        if (write) fs.writeFileSync(p, next);
      }
    }
  }
}
walk(CONTENT);

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
console.log(`${files.length} images (${mb(before)})${write ? ` -> ${converted} WebP (${mb(after)})` : ""}`);
console.log(`${refs} references in ${refFiles} content files ${write ? "updated" : "to update"}`);
if (!write) console.log("Dry run. Re-run with --write.");
