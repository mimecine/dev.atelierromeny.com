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

- **Thumbnail:** `thumbnail` picks which image appears in grids, search results and link previews: 1 is `image`, 2 is the first of `images`, and so on. The work page opens on that image, with the strip below in the saved order.
- **Addresses:** each work's canonical page is `/works/<slug>/`: search results, the sitemap and saved works link there, and its collection pages point their canonical link at it. `/_works/<slug>/` is the same page for browsing all works and is never indexed. `/works/` itself redirects home.
- **Old image:** `old_image` keeps the photo a work had before it was reshot. It's shown only when the work has no `image` or `images`.
- **Detail:** `detail` is the artwork alone: cut out of its photo, straightened, without frame or mat. It's shown last on the work page.
  - `scripts/make-details` (`make_details.py`) makes it from the work's chosen thumbnail photo.
  - **Outlines:** prints use `measure_prints.py`'s sheet and image detection; paintings use rembg, or the backdrop colour for close-ups on a plain background.
  - **Frames:** they're trimmed at the deepest straight line found on at least three sides.
  - **Review first:** run with `--review <folder>` for contact sheets. Doubtful results (CHECK) aren't written unless `--include-flagged`.
  - **Works never reshot:** where a work only had an old photo, its detail is used as `image` and the photo moved to `old_image`, so old photos stay out of sight.

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

## Edit links

When this browser is signed in to Sveltia (GitHub or local folder), every page shows a small "Edit" link at the top right, straight to its entry in the CMS:
- **work pages:** the work
- **markdown pages:** the page
- **home page:** Settings
- **collection pages:** the collection

Pages without an entry link to the CMS itself. Visitors never see it (`src/lib/cms-link.ts`; pages pass `cmsPath` to the layout), and it's left out when printing.

## Table view

`/admin/table/` edits the folder collections (works, collections, pages) as a spreadsheet, next to Sveltia. The "Table view" link is at the bottom left of the CMS. Code is in `src/admin-table/`.

- **Storage:** it works with whatever Sveltia is signed in with (`backend.ts`).
  - **GitHub:** it uses Sveltia's token (localStorage `sveltia-cms.user`), and each save is one commit.
  - **Local repository:** it opens the folder Sveltia was given. Sveltia keeps that folder's handle in IndexedDB (`github:<owner>/<repo>` › `file-system-handles` › `root_dir_handle`). Chrome asks for permission once, files are written directly, and you commit them yourself.
- **Columns:** they come from `public/admin/config.yml`, so new fields show up automatically.
  - Choose which are shown with "Columns", drag a header to reorder, and drag its right edge to resize. All three are remembered per collection; "Columns" also has a reset.
  - Settings that only the table view uses (Sveltia never sees them) are in `src/admin-table/settings.ts`. For works:
    - the image fields only offer that work's own images (the ones it references, plus media files named after it), and uploads from there are named after the work
    - `thumbnail` is shown as a chooser over the work's images, still stored as a number
- **Editing by field type:**
  - text and numbers: click to edit, Enter to save
  - yes/no fields: checkboxes, showing the field's default when the file has no value
  - relations: chips with × and a + picker
  - images: drop files on the cell, or click + (or the image) to pick from the media browser. Uploads are converted to WebP, at most 3000px, like Sveltia's.
  - lists of images: drag to reorder
  - fields it can't edit are shown read-only; edit those in Sveltia
- **Rich text:** markdown fields open a WYSIWYG editor in a dialog (`richtext.ts`). It's built on Lexical, the editor Sveltia uses, and has a Markdown tab for the source.
  - **Images:** they're kept as their own node, so `![alt](src "caption")` survives editing, and images can be dropped in.
  - **Unchanged text:** it's written back exactly as it was. Italics are written as `_text_`.
- **Saving:** "Save" (or Cmd/Ctrl+S) writes all edits and uploads together. Edited files are checked first: on GitHub it retries if only unrelated files changed, and otherwise (or locally) it says which entries changed elsewhere.
- **Media browser:** the "Media" button, or + on an image cell, opens the media folders from the config.
  - It searches by file name, shows a thumbnail grid, and uploads files dropped on it.
  - Uploads made there are saved with the next Save, even if no entry uses them yet.
- **Filters:** Tags, Categories and Collections dropdowns sit next to the search box (`FACETS` in `settings.ts`).
  - They list every value with a count, plus "(none)".
  - Several tags or collections must all match; several categories match any of them.
  - Active filters are remembered per collection; × clears one.
- **Hover preview:** hovering an image shows a larger version below it. It ignores the mouse, so clicks still go through.
- **Caching:** loaded collections are kept in this browser (IndexedDB `atelier-table`), so the table opens instantly from the cached copy, then refreshes.
  - **On GitHub:** a refresh compares Git object ids and downloads only files that changed.
  - **Your edits:** entries you've already edited aren't replaced by a refresh; saving reports any clash.
- **Thumbnails:** they load only as they come near the screen.
  - **Live site:** they come from `/admin/thumbs.json`, built with the site (240px thumbnails and 720px previews).
  - **Everywhere else** (images newer than the last build, local folders, `bun dev`, where that list is empty because dev doesn't resize images): the browser reads the image and shrinks it to 240px itself, a few at a time.
- **Missing features:** it doesn't create or delete entries; do that in Sveltia (each row's ↗ opens it there).

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

## Image scripts

The Python scripts in `scripts/` each have a launcher you can run directly. On first use, `scripts/py` creates `scripts/venv` and installs `scripts/requirements.txt` (about a minute); it reinstalls when that file changes. Pass `--help` for options.

| Launcher | Does |
|---|---|
| `scripts/measure-prints` | Measures prints in their photos and writes image and sheet sizes (cm). Calibrate first with `--calibrate`. |
| `scripts/make-details` | Makes each work's `detail` image. |
| `scripts/straighten-paintings` | Removes the background from painting photos and warps them flat. |
| `scripts/process-paintings`, `scripts/deskew-and-crop`, `scripts/straighten-painting` | Older crop and straighten experiments. |

Any other script runs the same way: `scripts/py some_script.py --flag`. Running `scripts/py` on its own just sets up or updates the environment.

## Gotchas

- **Every page must be prerendered** (`export const prerender = true`). Pages using `Layout.astro` render markdown with satteri, and sharp optimises the images. Neither can run inside the Cloudflare Worker, so a server-rendered page using the layout breaks the build.
- **`bun dev` doesn't optimise images.** sharp can't run in the dev server's Worker sandbox, so it uses a passthrough image service. The real build uses sharp.
- **Incremental builds** (`experimental.incrementalBuild`) reuse pages whose `cacheKey` hasn't changed. If built pages look stale, delete `dist`, `node_modules/.astro` and `node_modules/.vite` and build again.
- **Some elements survive page changes.** The password overlay and logout link use `transition:persist`, so they carry over when the ClientRouter swaps pages instead of flashing on every navigation.
- **Old scripts:** the older `.js` files and the Python scripts without a launcher in `scripts/` are leftovers from earlier image clean-ups and aren't part of any current workflow.
