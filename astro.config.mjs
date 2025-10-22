// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import alpinejs from '@astrojs/alpinejs';

import icon from 'astro-icon';


import pagefind from 'astro-pagefind';


// https://astro.build/config
export default defineConfig({
  site: 'https://dev.atelierromeny.com',
  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [alpinejs(), icon(), pagefind()]
});