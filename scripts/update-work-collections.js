import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';

// Directory paths
const contentDir = path.resolve(__dirname, '../src/content');
const worksDir = path.join(contentDir, 'works');

// Map categories to collection slugs - now with all discovered categories
const categoryToSlug = {
  'Abstrait': 'abstrait',
  'Abstract': 'abstrait',
  'abstrait': 'abstrait',
  'Accident dans la montagne': 'accident-dans-la-montagne',
  'Arbres': 'arbres',
  'Arbres en fleurs': 'arbres-en-fleurs',
  'Animaux': 'animaux',
  'Animals': 'animaux',
  'Birds': 'animaux',
  'Automne': 'automne',
  'Cartes': 'cartes',
  'Eté': 'ete',
  'Femme': 'la-vie-de-femme',
  'Feuilles': 'feuilles',
  'Figures': 'figures-humaines',
  'Figures humaines': 'figures-humaines',
  'figures humaines': 'figures-humaines',
  'Fleurs': 'fleurs',
  'La création': 'la-creation',
  'La vie de femme': 'la-vie-de-femme',
  'La vigne': 'la-vigne',
  'Le peintre et son model': 'le-peintre-et-son-model',
  'Les jours de la semaine': 'les-jours-de-la-semaine',
  "L'étreinte au monde": 'letreinte-au-monde',
  'Métro': 'metro',
  'Musique': 'musique',
  'Nature': 'nature',
  'Natures mortes': 'natures-mortes',
  'Nature Mortes': 'natures-mortes',
  'Nature Morte': 'natures-mortes',
  'Nature morte': 'natures-mortes',
  'natures mortes': 'natures-mortes',
  'Nues': 'nues',
  'Observations': 'observations',
  'Paysages': 'paysages',
  'Paysage': 'paysages',
  'Landscape': 'paysages',
  'Plantes': 'plantes',
  'Portrait': 'portraits',
  'Rues': 'rues',
  'Tauromachie': 'tauromachie'
};

function main() {
  const mdFiles = glob.sync(`${worksDir}/**/*.md`);
  let unknownCategories = new Set();
  
  mdFiles.forEach(mdPath => {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const { data, content } = matter(raw);
    
    if (data.categories) {
      // Get the collection slug for this category
      const collectionSlug = categoryToSlug[data.categories];
      
      if (collectionSlug) {
        // Add the collection slug to collections array if it doesn't exist
        data.collections = data.collections || [];
        if (!data.collections.includes(collectionSlug)) {
          data.collections.push(collectionSlug);
        }
        
        // Write back to file
        const newContent = matter.stringify(content, data);
        fs.writeFileSync(mdPath, newContent, 'utf-8');
        console.log(`Updated collections in: ${mdPath}`);
      } else {
        unknownCategories.add(data.categories);
        console.warn(`Unknown category "${data.categories}" in file: ${mdPath}`);
      }
    }
  });

  if (unknownCategories.size > 0) {
    console.log('\nUnknown categories found:');
    unknownCategories.forEach(cat => console.log(`- "${cat}"`));
  }
}

main();
