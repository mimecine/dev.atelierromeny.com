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
    // Rewrite astro:assets <Image>s to Cloudflare's /cdn-cgi/image/ URL
    // transform instead of the local sharp pipeline. Unlike
    // 'cloudflare-binding', this works the same for prerendered pages (the
    // whole works/collections catalog) and on-demand ones: it's a plain
    // string rewrite done at render time either way, with the actual
    // resizing happening lazily at Cloudflare's edge proxy on first
    // request (then cached) rather than as a build-time or per-request
    // Worker call. Requires "Image Transformations" enabled on the zone.
    imageService: 'cloudflare'
  })
});