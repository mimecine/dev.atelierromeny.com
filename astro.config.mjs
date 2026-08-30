// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import alpinejs from '@astrojs/alpinejs';

import icon from 'astro-icon';


import pagefind from 'astro-pagefind';


import cloudflare from '@astrojs/cloudflare';

// sharp is a native addon and cannot run inside workerd at all, at any
// point - not just during prerendering (handled separately below via
// adapter.prerenderEnvironment), but also for any live image request
// `astro dev` itself serves, since its request-handling sandbox is workerd
// too. So `astro dev` gets a real (if unoptimized) passthrough image
// service instead of sharp; `astro build`/`astro preview` keep Astro's
// default sharp service, since a real Node process (not workerd) always
// does the actual optimizing (see prerenderEnvironment: 'node' below).
const isDev = process.argv[2] === 'dev';

// https://astro.build/config
export default defineConfig({
  site: 'https://dev.atelierromeny.com',
  output: 'server',

  image: isDev ? { service: passthroughImageService() } : undefined,

  vite: {
    plugins: [tailwindcss()],
    // sharp is a native addon; Vite's SSR dep optimizer (used by the
    // adapter's workerd dev runner) chokes trying to pre-bundle it and
    // crashes `astro dev` outright. It only ever needs to run at build
    // time (see adapter.prerenderEnvironment below), so keep it out of
    // the dev-time dependency graph entirely.
    ssr: {
      external: ['sharp']
    },
    optimizeDeps: {
      exclude: ['astro/assets/services/sharp', 'sharp']
    }
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
    // Every 'imageService' built-in mode except 'custom' silently forces
    // astro:assets onto a Cloudflare Images backend (binding or URL
    // transform), even when a real image.service is configured - there's
    // no supported way to keep local sharp otherwise. 'custom' is the
    // documented escape hatch: it leaves the top-level `image` config
    // (above) alone instead of overriding it.
    imageService: 'custom',
    // sharp is a native addon and can't run inside workerd, so prerendering
    // (which otherwise defaults to a workerd sandbox for runtime fidelity)
    // needs to run in plain Node instead. Every route touching <Image> is
    // `export const prerender = true`, so sharp never needs to run in the
    // actual deployed Worker - only here, at build time.
    prerenderEnvironment: 'node'
  })
});