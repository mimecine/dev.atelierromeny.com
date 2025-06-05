import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';

// Directory paths
const contentDir = path.resolve(__dirname, '../src/content');
const mediaDir = path.resolve(__dirname, '../src/media/img');

function main() {
  // Specifically target only markdown files in the works directory
  const mdFiles = glob.sync(`${contentDir}/works/**/*.md`);
  
  mdFiles.forEach(mdPath => {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const { data, content } = matter(raw);
    const slug = path.basename(mdPath, '.md').replace(/^_+/, '');
    
    // Only process if we have an image reference
    if (data.image) {
      // Get current image filename and extension
      const currentImage = path.basename(data.image);
      const ext = path.extname(currentImage);
      const newImageName = `${slug}${ext}`;
      
      // Physical image path
      const oldImagePath = path.join(mediaDir, currentImage);
      const newImagePath = path.join(mediaDir, newImageName);
      
      // Rename physical file if it exists and needs renaming
      if (fs.existsSync(oldImagePath) && oldImagePath !== newImagePath) {
        try {
          console.log(`Renaming: ${currentImage} -> ${newImageName}`);
          fs.renameSync(oldImagePath, newImagePath);
        } catch (err) {
          console.error(`Error renaming ${currentImage}: ${err.message}`);
        }
      }
      
      // Update markdown frontmatter
      data.image = `@img/${newImageName}`;
      data.file = `@img/${newImageName}`;
      
      // Preserve the original content when writing back
      const newContent = matter.stringify(content, data);
      fs.writeFileSync(mdPath, newContent, 'utf-8');
      console.log(`Updated: ${mdPath}`);
    }
  });
}

main();
