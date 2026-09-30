# Atelier Romeny

Portfolio site for the painter Edlef Romeny (1926–2017), with his paintings and prints.

Built with Astro 7, Tailwind CSS 4 and Alpine.js. Content is edited in [Sveltia CMS](https://github.com/sveltia/sveltia-cms) at `/admin`. The site runs as a Cloudflare Worker, and every page is prerendered at build time.

## Commands

Bun is the package manager and script runner.

| Command | What it does |
| :-- | :-- |
| `bun install` | Install dependencies |
| `bun dev` | Dev server at `localhost:4321`. Images are served unoptimised (see *Gotchas*) |
| `bun run build` | Production build to `dist/` |
| `bun run cf:preview` | Build and run it locally in Wrangler, as it runs on Cloudflare |
| `bun run deploy` | Build and deploy by hand (normally not needed, see *Deploying*) |
| `bun run match-photos <folder> [ids.txt]` | Photo matcher, see *Adding new photos of works* |
| `bun run apply-photos <folder> [--write]` | Import matched photos into the site |

## Deploying

Cloudflare is connected to the GitHub repo, so every push to `main` builds and deploys. Edits saved in the CMS are commits to `main` too, so pull before working locally.

## Content

Everything is in `src/content/`, and each part can be edited in the CMS:

| Path | What it holds |
| :-- | :-- |
| `works/*.md` | One file per work: `id` (inventory number), title, year, size, location, `image`, extra `images`, `thumbnail`, `collections` |
| `collections/*.md` | Named groups of works. Each has its own page at `/<collection>` and its works at `/<collection>/<work>` |
| `pages/*.md` | Free pages such as `bio.md`, served at `/<page>`. A page's `image` floats to the right of its text |
| `settings.yml` | Site title, menu, front page sections, footer links, password protection |

A few notes on works:

- **Thumbnail:** `thumbnail` picks which image appears in grids and search results: 1 is `image`, 2 is the first of `images`, and so on. The work page always shows the images in their saved order.
- **All works:** every work with an image also appears in `/_works`, the collection of all works. That's also the address search results link to.
- **Old image:** `old_image` keeps the photo a work had before it was reshot. It isn't shown on the site.

### Front page sections

Set in *Settings → Frontpage Settings → Frontpage Sections*. Each type has its own component in `src/components/sections/`:

- **Free Content:** markdown text in 1–3 columns. Images inside the text are optimised.
- **Large Image:** a left-aligned image with an optional caption and link.
- **Carousel:** 1–3 images visible at a time, with a height and optional autoplay. Autoplay pauses on hover, stops once a visitor uses the arrows, and stays off for visitors whose device is set to reduce motion.
- **Collection:** a grid of 2–6 columns with a maximum number of rows, plus a "View all" link when works are left out.

### Media

| Folder | Holds |
| :-- | :-- |
| `src/media/works/` | Images of works |
| `src/media/assets/` | Everything else: page, settings and collection images |

- **Paths:** content stores images as `/src/media/…`, the form Sveltia writes by default.
- **Frontmatter and settings:** `image()` fields resolve these paths directly. For settings, `src/lib/media.ts` does the same job.
- **Images inside markdown text:** these are handled by a satteri plugin, `src/lib/satteri-image-path-fix.js`.
- **Format:** everything is WebP. Sveltia converts uploads to WebP at a maximum of 3000px.

### Search

Search uses [Pagefind](https://pagefind.app), built into `dist/client/pagefind` at build time. Pages opt in to being indexed with `<Layout searchable>`:

- **Works:** indexed once each, at their `/_works/` address.
- **Collections and pages:** indexed as well.

`<SearchMeta>` gives each indexed page its result title and type, and an `<img data-pagefind-meta="image[src]">` on the page gives it a thumbnail.

The search page (`src/pages/search.astro`) renders its own results. It lists collections first, then pages, then works, pages through them, and keeps `?q=` in the URL, so Back returns to the same results.

### Search engines

Only the collections linked from *Settings → Menu* are open to search engines, along with the works shown under those collections, the home page and the markdown pages. Every other collection, the `/_works/` and `/works/` duplicates, Search and Saved are marked `noindex` (see `isMenuCollection` in `src/lib/settings.ts`). The collections' own "Shown In Menu" flag isn't used for this. The same pages are listed in `/sitemap.xml` (submitted in Google Search Console), and `robots.txt` points to it.

## Adding new photos of works

For a batch of reshot paintings:

1. **Start the matcher.** `bun run match-photos path/to/photos ids.txt` opens a local page at `localhost:4455`.
   - **The id list:** one inventory number per line, in the order the paintings were shot. It's only needed the first time.
   - **Sequence view:** shows each id's current photo next to the next new photo. Use Enter to match, A for an extra image, N for a new work without an id (such as a print), and Z to undo.
   - **Grid view:** puts unmatched ids and unmatched photos side by side, to match by dragging.
   - **Saving:** progress is saved to `matches.json` in the photo folder.
2. **Preview the import.** `bun run apply-photos path/to/photos` is a dry run that shows what will happen.
3. **Import.** `bun run apply-photos path/to/photos --write` does it:
   - Photos are copied into `src/media/works/` as `<id>-<title>.webp`, at a maximum of 3000px.
   - Each work's previous image moves to `old_image`.
   - Matched works are added to the `new-paintings` collection.
   - Works made with N become untitled `print-NNN` works in the `prints` collection.

   Running it again is safe.

If the camera files are large, `bun scripts/photo-matcher/to-webp.ts <folder>` replaces them with 3000px WebP copies and updates `matches.json`. **It deletes the originals**, so keep a copy elsewhere.

## Password protection

A simple password screen is set in *Settings → Password Protection*: on or off, the password, how many days it's remembered, and optional text. Changing the password logs everyone out.

It keeps casual visitors out while the site is being built. It is not real security, because the password is in the page source.

## Gotchas

- **Every page must be prerendered** (`export const prerender = true`). Pages using `Layout.astro` render markdown with satteri, and sharp optimises the images. Neither can run inside the Cloudflare Worker, so a server-rendered page using the layout breaks the build.
- **`bun dev` doesn't optimise images.** sharp can't run in the dev server's Worker sandbox, so it uses a passthrough image service. The real build uses sharp.
- **Incremental builds** (`experimental.incrementalBuild`) reuse pages whose `cacheKey` hasn't changed. If built pages look stale, delete `dist`, `node_modules/.astro` and `node_modules/.vite` and build again.
- **Some elements survive page changes.** The password overlay and logout link use `transition:persist`, so they carry over when the ClientRouter swaps pages instead of flashing on every navigation.
- **Old scripts:** the Python scripts and the older `.js` files in `scripts/` are leftovers from earlier image clean-ups and aren't part of any current workflow.
