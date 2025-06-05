import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { v4 as uuidv4 } from 'uuid';

const worksDir = path.resolve(__dirname, '../src/content/works');
const mediaDir = path.resolve(__dirname, '../src/media/img');

function lintImages() {
  const markdownFiles = glob.sync(`${worksDir}/*.md`);
  const missingImages = [];

  markdownFiles.forEach((file) => {
    const content = fs.readFileSync(file, 'utf-8');
    const { data } = matter(content);

    if (!data.id) {
      console.log(`Missing id in file: ${file}`);
    }

    // if (data.image) {
    //   const imagePath = path.resolve(worksDir, data.image);
    //   if (!fs.existsSync(imagePath)) {
    //     missingImages.push({ file, image: data.image });
    //   }
    // }
  });

  //   if (missingImages.length > 0) {
  //     console.log('Missing images found:');
  //     missingImages.forEach(({ file, image }) => {
  //     //   console.log(`- File: ${file}, Missing Image: ${image}`);
  //     console.log(`${file.replace(/(.*)\/([^\\]+)$/, '$1/_$2')}`);
  //     // fs.renameSync(file, file.replace(/(.*)\/([^\\]+)$/, '$1/_$2'));
  //     });
  //   } else {
  //     console.log('All images are present.');
  //   }
}

function ensureUUID() {
  const markdownFiles = glob.sync(`${worksDir}/*.md`);

  markdownFiles.forEach((file) => {
    const content = fs.readFileSync(file, 'utf-8');
    const { data, content: markdownContent } = matter(content);

    if (data.uuid) {
      data.uuid = uuidv4();
      const updatedContent = matter.stringify(markdownContent, data);
      fs.writeFileSync(file, updatedContent, 'utf-8');
      console.log(`Added uuid to file: ${file}`);
    }
  });
}

ensureUUID();
// lintImages();