// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import alpinejs from '@astrojs/alpinejs';

import icon from 'astro-icon';


import pagefind from 'astro-pagefind';


import cloudflare from '@astrojs/cloudflare';


// https://astro.build/config
export default defineConfig({
  site: 'https://dev.atelierromeny.com',
  output: 'server',

  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [alpinejs(), icon(), pagefind()],

  experimental: {
    // Skip re-rendering static pages whose `cacheKey` (see each route's
    // getStaticPaths) hasn't changed since the last build. Only affects
    // routes marked `export const prerender = true`.
    // https://docs.astro.build/en/reference/experimental-flags/incremental-build/
    incrementalBuild: true
  },

  adapter: cloudflare({
    // Transform astro:assets <Image>s at request time via the Cloudflare
    // Images binding instead of the local sharp pipeline.
    imageService: 'cloudflare-binding'
  })
});