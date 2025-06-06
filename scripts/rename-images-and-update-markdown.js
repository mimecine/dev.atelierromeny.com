import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';

// Directory paths
const contentDir = path.resolve(__dirname, '../src/content');
const mediaDir = path.resolve(__dirname, '../src/media/img');

function main() {
  // 1. Scan all markdown files and build a map of old->new image renames
  const mdFiles = glob.sync(`${contentDir}/works/**/*.md`);
  const renameMap = new Map(); // oldImageName -> { newImageName, mdPaths: [] }
  const newNameToOld = new Map(); // newImageName -> oldImageName (for conflict check)
  const mdUpdates = [];

  mdFiles.forEach(mdPath => {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const { data, content } = matter(raw);
    const slug = path.basename(mdPath, '.md').replace(/^_+/, '');
    if (data.image) {
      const currentImage = path.basename(data.image);
      const ext = path.extname(currentImage);
      const newImageName = `${slug}${ext}`;
      if (!renameMap.has(currentImage)) {
        renameMap.set(currentImage, { newImageName, mdPaths: [mdPath] });
      } else {
        // Multiple markdowns reference the same image
        renameMap.get(currentImage).mdPaths.push(mdPath);
      }
      if (newNameToOld.has(newImageName) && newNameToOld.get(newImageName) !== currentImage) {
        console.error(`[ERROR] Conflict: multiple images want to be renamed to ${newImageName}`);
      }
      newNameToOld.set(newImageName, currentImage);
      mdUpdates.push({ mdPath, newImageName });
    }
  });

  // 2. Perform all renames (copy+delete if needed)
  for (const [oldImageName, { newImageName }] of renameMap.entries()) {
    const oldImagePath = path.join(mediaDir, oldImageName);
    const newImagePath = path.join(mediaDir, newImageName);
    if (!fs.existsSync(oldImagePath)) {
      // Already renamed or missing
      if (!fs.existsSync(newImagePath)) {
        console.warn(`[WARN] Missing image: ${oldImagePath}`);
      }
      continue;
    }
    if (oldImagePath === newImagePath) {
      // No rename needed
      continue;
    }
    if (fs.existsSync(newImagePath)) {
      // Don't overwrite existing files
      console.error(`[ERROR] Target file already exists: ${newImagePath}. Skipping rename of ${oldImagePath}`);
      continue;
    }
    try {
      // Use copy+delete to avoid issues if source/dest overlap
      fs.copyFileSync(oldImagePath, newImagePath);
      fs.unlinkSync(oldImagePath);
      console.log(`Renamed (copy+delete): ${oldImageName} -> ${newImageName}`);
    } catch (err) {
      console.error(`[ERROR] Failed to rename ${oldImageName}: ${err.message}`);
    }
  }

  // 3. Update markdown frontmatter
  for (const { mdPath, newImageName } of mdUpdates) {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const { data, content } = matter(raw);
    data.image = `@img/${newImageName}`;
    data.file = `@img/${newImageName}`;
    const newContent = matter.stringify(content, data);
    fs.writeFileSync(mdPath, newContent, 'utf-8');
    console.log(`Updated: ${mdPath}`);
  }
}

main();
