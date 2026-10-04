// Spreadsheet-style editor for the folder collections in public/admin/config.yml.
// Lives next to Sveltia CMS (at /admin/table/), shares its config and whatever it is
// working with (GitHub, or a local repository folder), and saves each batch of edits
// together. See README.md ("Table view").
import { parse as parseYaml } from "yaml";
import { type Repo } from "./github";
import {
  githubBackend,
  localBackend,
  sveltiaFolderHandle,
  sveltiaUser,
  type Backend,
  type Change,
} from "./backend";
import { editMarkdown } from "./richtext";
import {
  columnsOf,
  parseEntry,
  readStrings,
  serializeEntry,
  templateValue,
  writeStrings,
  type CollectionConfig,
  type Column,
  type Entry,
  type FieldConfig,
} from "./model";
import { prepareUpload, slugifyBase } from "./images";
import { COLUMN_DEFAULTS, FACETS, FIELD_OPTIONS, PRICING_FILE, computedColumns, pricing } from "./settings";

// ---------------------------------------------------------------- state

interface Upload {
  blob: Blob;
  url: string;
  repoPath: string;
  /** uploaded from the media browser: saved even if no entry uses it (yet) */
  keep?: boolean;
}

interface MediaFolder {
  label: string;
  /** repo path, e.g. "src/media/works" */
  media: string;
  /** path as stored in content, e.g. "/src/media/works" */
  pub: string;
}

const state = {
  backend: undefined as unknown as Backend,
  repo: { owner: "", name: "", branch: "main" } as Repo,
  config: {} as { media_folder?: string; public_folder?: string; collections: CollectionConfig[] },
  collection: undefined as CollectionConfig | undefined,
  columns: [] as Column[],
  hidden: new Set<string>(),
  entries: [] as Entry[],
  filter: "",
  /** toolbar filters: column key -> chosen values ("" = entries with no value) */
  facets: {} as Record<string, Set<string>>,
  sort: undefined as { key: string; dir: 1 | -1 } | undefined,
  uploads: new Map<string, Upload>(),
  thumbs: {} as Record<string, string>,
  previews: {} as Record<string, string>,
  rawThumbs: new Map<string, Promise<string>>(),
  rawPreviews: new Map<string, Promise<string>>(),
  order: [] as string[],
  widths: {} as Record<string, number>,
  relations: new Map<string, Promise<Entry[]>>(),
  mediaLists: new Map<string, Promise<string[]>>(),
  saving: false,
};

// ---------------------------------------------------------------- helpers

type Attrs = Record<string, unknown> & { class?: string; on?: Record<string, (e: any) => void> };
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v as Record<string, any>)) el.addEventListener(ev, fn);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const stripSlash = (p: string) => p.replace(/^\/+/, "");

function status(message: string, kind: "info" | "error" | "ok" = "info", link?: { href: string; text: string }) {
  const el = $("#status");
  el.className = `status ${kind}`;
  el.replaceChildren(message, link ? h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text) : "");
}

const dirtyEntries = () => state.entries.filter((e) => e.dirty.size > 0);

const keptUploads = () => [...state.uploads.values()].filter((u) => u.keep);

function updateToolbar() {
  const n = dirtyEntries().length;
  const u = keptUploads().length;
  const save = $<HTMLButtonElement>("#save");
  save.disabled = (n === 0 && u === 0) || state.saving;
  const parts = [n && `${n} change${n === 1 ? "" : "s"}`, u && `${u} image${u === 1 ? "" : "s"}`].filter(Boolean);
  save.textContent = state.saving ? "Saving…" : parts.length ? `Save ${parts.join(" + ")}` : "Saved";
  $<HTMLButtonElement>("#discard").hidden = (n === 0 && u === 0) || state.saving;
}

function setValue(entry: Entry, col: Column, value: unknown) {
  entry.data[col.key] = value;
  entry.dirty.add(col.key);
  updateToolbar();
  refreshCell(entry, col);
  for (const c of state.columns) if (c.computed?.from.includes(col.key)) refreshCell(entry, c);
}

// ---------------------------------------------------------------- media

const folderLabel = (media: string) => {
  const last = media.split("/").pop() || media;
  return last.charAt(0).toUpperCase() + last.slice(1);
};

function makeFolder(media: string, pub?: string): MediaFolder {
  const m = stripSlash(media).replace(/\/+$/, "");
  return { label: folderLabel(m), media: m, pub: (pub ?? `/${m}`).replace(/\/+$/, "") };
}

/** The media folder a column uploads to (field, then collection, then site default). */
function mediaFolderFor(col: Column): MediaFolder {
  const c = state.collection!;
  const media = col.field.field?.media_folder ?? col.field.media_folder ?? c.media_folder ?? state.config.media_folder ?? "src/media";
  const pub = col.field.field?.public_folder ?? col.field.public_folder ?? c.public_folder ?? state.config.public_folder;
  return makeFolder(media, pub);
}

/** Every media folder in the config (site default and per collection). */
function allMediaFolders(): MediaFolder[] {
  const list = [
    ...(state.config.media_folder ? [makeFolder(state.config.media_folder, state.config.public_folder)] : []),
    ...state.config.collections.filter((c) => c.media_folder).map((c) => makeFolder(c.media_folder!, c.public_folder)),
  ];
  return list.filter((f, i) => list.findIndex((g) => g.media === f.media) === i);
}

const stageUploads = (col: Column, files: File[]) => stageUploadsTo(mediaFolderFor(col), files);

/** `baseName` names uploads after an entry ("<slug>-2.webp") instead of the file. */
async function stageUploadsTo(folder: MediaFolder, files: File[], keep = false, baseName?: string): Promise<string[]> {
  const { media, pub } = folder;
  const existing = new Set(await listMedia(folder).catch(() => [] as string[]));
  const paths: string[] = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    status(`Preparing ${file.name}…`);
    const { blob, ext } = await prepareUpload(file);
    const base = baseName ? slugifyBase(baseName) : slugifyBase(file.name);
    let name = `${base}.${ext}`;
    for (let i = 2; existing.has(name) || state.thumbs[`${pub}/${name}`] || state.uploads.has(`${pub}/${name}`); i++) name = `${base}-${i}.${ext}`;
    const publicPath = `${pub}/${name}`;
    state.uploads.set(publicPath, { blob, url: URL.createObjectURL(blob), repoPath: `${media}/${name}`, keep });
    paths.push(publicPath);
  }
  status(paths.length ? `${paths.length} image${paths.length === 1 ? "" : "s"} ready; they're uploaded when you save.` : "No images in that drop.");
  updateToolbar();
  return paths;
}

const IMAGE_FILE = /\.(webp|jpe?g|png|gif|avif|svg)$/i;

function listMedia(folder: MediaFolder): Promise<string[]> {
  let p = state.mediaLists.get(folder.media);
  if (!p) {
    p = state.backend.listFolder(folder.media).then((names) => names.filter((n) => IMAGE_FILE.test(n)));
    state.mediaLists.set(folder.media, p);
  }
  return p;
}

// Small thumbnails made in the browser for images without a built one (dev server,
// new uploads, local folders): a few at a time, scaled to 240px.
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function shrink(blob: Blob, size = 240): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
    if (scale === 1) {
      bmp.close();
      return blob;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise<Blob>((r) => canvas.toBlob((b) => r(b ?? blob), "image/webp", 0.8));
  } catch {
    return blob;
  }
}

/** Thumbnail URL for a stored path: a pending upload, the build's thumbnail, or GitHub. */
function thumbFor(path: string): string | Promise<string> {
  const up = state.uploads.get(path);
  if (up) return up.url;
  const built = state.thumbs[path];
  if (built) return built;
  let p = state.rawThumbs.get(path);
  if (!p) {
    p = limited(async () => URL.createObjectURL(await shrink(await state.backend.readBlob(stripSlash(path)))));
    state.rawThumbs.set(path, p);
  }
  return p;
}

/** A larger version for the hover preview: the build's preview size, or shrunk to 720px. */
function previewFor(path: string): string | Promise<string> {
  const up = state.uploads.get(path);
  if (up) return up.url;
  const built = state.previews[path];
  if (built) return built;
  let p = state.rawPreviews.get(path);
  if (!p) {
    p = limited(async () => URL.createObjectURL(await shrink(await state.backend.readBlob(stripSlash(path)), 720)));
    state.rawPreviews.set(path, p);
  }
  return p;
}

// Hovering a thumbnail shows a larger version just below it. The preview ignores the
// mouse (pointer-events: none), so the thumbnail and its buttons stay clickable.
// Clicking a photo in an image list opens the bigger viewer, with its controls (below).
const preview = h("div", { class: "preview", hidden: true }, h("img", { alt: "" }));
let previewTimer: number | undefined;
let previewFor_: HTMLImageElement | undefined;

/** Image-list photos: which entry, column and position they show (for the viewer). */
const tileInfo = new WeakMap<HTMLImageElement, { entry: Entry; col: Column; index: number }>();
const columnByKey = (key: string) => state.columns.find((c) => c.key === key);

function showPreview(img: HTMLImageElement) {
  previewFor_ = img;
  const target = preview.querySelector("img")!;
  const place = () => {
    if (previewFor_ !== img) return;
    const r = img.getBoundingClientRect();
    preview.hidden = false;
    const w = preview.offsetWidth, ph = preview.offsetHeight;
    preview.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    const below = r.bottom + 6;
    preview.style.top = `${below + ph > innerHeight - 8 ? Math.max(8, r.top - ph - 6) : below}px`;
  };
  target.onload = place;
  const src = previewFor(img.dataset.path!);
  if (typeof src === "string") target.src = src;
  else {
    target.removeAttribute("src");
    src.then((u) => previewFor_ === img && (target.src = u)).catch(() => {});
  }
  if (target.complete && target.naturalWidth) place();
}
function hidePreview() {
  clearTimeout(previewTimer);
  previewFor_ = undefined;
  preview.hidden = true;
}
document.addEventListener("mouseover", (e) => {
  const img = (e.target as HTMLElement).closest?.("img.thumb") as HTMLImageElement | null;
  if (!img || img === previewFor_ || img.closest(".viewer") || viewing) return;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => showPreview(img), 250);
});
document.addEventListener("mouseout", (e) => {
  if ((e.target as HTMLElement).closest?.("img.thumb")) hidePreview();
});
addEventListener("scroll", hidePreview, true);

// ---------------------------------------------------------------- image viewer

// Clicking a photo in an image list opens this full-window viewer: every image of the
// entry in a grid, each with its own Hidden / Thumbnail / Cleanest checkboxes (where
// the image list has those fields). The clicked photo is highlighted. × or Esc closes.
const viewer = h("div", { class: "viewer", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Images" });
let viewing: { entry: Entry; col: Column; index: number } | undefined;

function viewerList() {
  return viewing ? ((viewing.entry.data[viewing.col.key] ?? []) as unknown[]).map(String) : [];
}

function openViewer(entry: Entry, col: Column, index: number) {
  hidePreview();
  viewing = { entry, col, index };
  renderViewer();
  viewer.hidden = false;
  document.body.classList.add("viewer-open");
  viewer.querySelector(".viewer-tile.current")?.scrollIntoView({ block: "center" });
}

function closeViewer() {
  viewing = undefined;
  viewer.hidden = true;
  document.body.classList.remove("viewer-open");
}

function renderViewer() {
  if (!viewing) return;
  const { entry, col } = viewing;
  const list = viewerList();
  if (!list.length) return closeViewer();
  const hideKey = col.options.hideIn, thumbKey = col.options.thumbnailIn, cleanKey = col.options.cleanestIn;
  const scrollTop = viewer.querySelector(".viewer-grid")?.scrollTop ?? 0;

  const box = (label: string, checked: boolean, title: string, onChange: (on: boolean) => void) => {
    const input = h("input", { type: "checkbox" }) as HTMLInputElement;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return h("label", { title }, input, label);
  };
  const changed = () => {
    refreshCell(entry, col);
    renderViewer();
  };

  const tiles = list.map((path, index) => {
    const controls: HTMLElement[] = [];
    if (hideKey) {
      const hidden: string[] = (entry.data[hideKey] ?? []).map(String);
      controls.push(
        box("Hidden", hidden.includes(path), "Kept in the list, left off the site", (on) => {
          const next = on ? [...hidden, path] : hidden.filter((p) => p !== path);
          setValue(entry, columnByKey(hideKey)!, next.length ? next : null);
          changed();
        })
      );
    }
    if (thumbKey) {
      const n = Number(entry.data[thumbKey]) || 1;
      controls.push(
        box("Thumbnail", n === index + 1, "Shown in grids, search and link previews", (on) => {
          const k = on ? index + 1 : 1;
          setValue(entry, columnByKey(thumbKey)!, k === 1 ? null : k);
          changed();
        })
      );
    }
    if (cleanKey) {
      controls.push(
        box("Cleanest", entry.data[cleanKey] === path, "The photo the measuring and cropping scripts use (even if hidden)", (on) => {
          const cleanCol = columnByKey(cleanKey);
          if (cleanCol) setValue(entry, cleanCol, on ? path : null);
          else {
            // the column may be absent from older configs: set the value directly
            entry.data[cleanKey] = on ? path : null;
            entry.dirty.add(cleanKey);
            updateToolbar();
          }
          changed();
        })
      );
    }
    const img = h("img", { alt: "", title: path.split("/").pop(), loading: "lazy" }) as HTMLImageElement;
    const src = previewFor(path);
    if (typeof src === "string") img.src = src;
    else src.then((u) => (img.src = u)).catch(() => img.classList.add("broken"));
    const hiddenNow = hideKey && (entry.data[hideKey] ?? []).map(String).includes(path);
    return h(
      "figure",
      { class: `viewer-tile${index === viewing!.index ? " current" : ""}${hiddenNow ? " is-hidden" : ""}` },
      h("div", { class: "viewer-controls" }, h("span", { class: "viewer-num" }, String(index + 1)), ...controls),
      h("div", { class: "viewer-img" }, img),
      h("figcaption", {}, path.split("/").pop()!)
    );
  });

  viewer.replaceChildren(
    h(
      "div",
      { class: "viewer-head" },
      h("h2", {}, `${entry.data.title ?? entry.slug}`),
      h("span", { class: "viewer-count" }, `${list.length} image${list.length === 1 ? "" : "s"}`),
      h("button", { type: "button", class: "viewer-close", title: "Close (Esc)", on: { click: closeViewer } }, "×")
    ),
    h("div", { class: "viewer-grid" }, ...tiles)
  );
  const grid = viewer.querySelector(".viewer-grid");
  if (grid) grid.scrollTop = scrollTop;
}

document.addEventListener("click", (e) => {
  const img = (e.target as HTMLElement).closest?.("img.thumb") as HTMLImageElement | null;
  const info = img && tileInfo.get(img);
  if (info) {
    e.stopPropagation();
    return openViewer(info.entry, info.col, info.index);
  }
});
document.addEventListener("keydown", (e) => {
  if (viewing && e.key === "Escape") {
    e.preventDefault();
    closeViewer();
  }
});

const lazyImages = new IntersectionObserver(
  (items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      const img = it.target as HTMLImageElement;
      lazyImages.unobserve(img);
      const src = thumbFor(img.dataset.path!);
      if (typeof src === "string") img.src = src;
      else src.then((u) => (img.src = u)).catch(() => img.classList.add("broken"));
    }
  },
  { rootMargin: "400px" }
);

/** Thumbnails load when they come near the screen, never all at once. */
function thumb(path: string, extra: Attrs = {}) {
  const img = h("img", { class: "thumb", alt: "", title: path.split("/").pop(), "data-path": path, ...extra });
  const up = state.uploads.get(path);
  if (up) img.src = up.url;
  else lazyImages.observe(img);
  return img;
}

function pickFiles(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: "image/*", multiple });
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

/** Accept image files dropped on `el` (handler properties, so re-rendering a cell
 *  replaces them rather than stacking listeners). */
function fileDropTarget(el: HTMLElement, onFiles: (files: File[]) => void) {
  el.ondragover = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    el.classList.add("drop");
  };
  el.ondragleave = () => el.classList.remove("drop");
  el.ondrop = (e: DragEvent) => {
    el.classList.remove("drop");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    onFiles(files);
  };
}

// ---------------------------------------------------------------- entry images

/** Image paths an entry references in its image fields, in field order. */
function referencedImages(entry: Entry): string[] {
  const out: string[] = [];
  for (const col of state.columns) {
    const v = entry.data[col.key];
    if (col.kind === "image" && v) out.push(String(v));
    if (col.kind === "images" && Array.isArray(v)) out.push(...v.map(String));
  }
  return [...new Set(out)];
}

/** An entry's images: the ones it references plus media files named after it
 *  ("<slug>…" or "<id>-…"), including uploads waiting to be saved. */
async function entryImages(entry: Entry, folder: MediaFolder): Promise<string[]> {
  const names = await listMedia(folder).catch(() => [] as string[]);
  const prefixes = [entry.slug, entry.data.id != null && entry.data.id !== "" ? `${entry.data.id}-` : ""].filter(Boolean).map((p) => p.toLowerCase());
  const own = (name: string) => prefixes.some((p) => name.toLowerCase().startsWith(p));
  const pending = [...state.uploads.keys()].filter((p) => p.startsWith(folder.pub + "/") && own(p.split("/").pop()!));
  const files = names.filter(own).map((n) => `${folder.pub}/${n}`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [...new Set([...referencedImages(entry), ...pending, ...files])];
}

// ---------------------------------------------------------------- media browser

/**
 * Browse, search and upload images in the media folders. With `pick`, clicking images
 * selects them and the promise resolves with their paths ([] when cancelled).
 */
function mediaBrowser(opts: { folder?: MediaFolder; pick?: "one" | "many"; entry?: Entry } = {}): Promise<string[]> {
  // With `entry`, only that entry's images are shown (one "This work" tab) and uploads
  // are named after it.
  const ENTRY = "\u0000entry";
  const folders: MediaFolder[] = opts.entry
    ? [{ label: `This ${(state.collection?.label_singular ?? "entry").toLowerCase()}`, media: ENTRY, pub: opts.folder!.pub }]
    : allMediaFolders();
  if (!opts.entry && opts.folder && !folders.some((f) => f.media === opts.folder!.media)) folders.unshift(opts.folder);
  let folder = opts.entry ? folders[0] : folders.find((f) => f.media === opts.folder?.media) ?? folders[0];
  const uploadFolder = () => (opts.entry ? opts.folder! : folder);
  const selected: string[] = [];
  let resolveResult: (paths: string[]) => void;
  const result = new Promise<string[]>((r) => (resolveResult = r));
  let chosen: string[] = [];

  const search = h("input", { type: "search", placeholder: "Search file names…", class: "media-search" }) as HTMLInputElement;
  const grid = h("div", { class: "media-grid" });
  const info = h("span", { class: "media-info" });
  const tabs = h("div", { class: "rt-tabs" });
  const insert = h("button", { type: "button", class: "primary", hidden: !opts.pick }, "Insert");
  const upload = h("button", { type: "button" }, "Upload…");

  const render = async () => {
    tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.media === folder.media));
    grid.replaceChildren(h("p", { class: "media-empty" }, "Loading…"));
    let paths: string[];
    try {
      if (opts.entry) paths = await entryImages(opts.entry, opts.folder!);
      else {
        const names = await listMedia(folder);
        const pending = [...state.uploads.entries()].filter(([, u]) => u.repoPath.startsWith(folder.media + "/")).map(([p]) => p);
        paths = [...pending, ...names.map((n) => `${folder.pub}/${n}`).filter((p) => !pending.includes(p)).sort((a, b) => a.localeCompare(b))];
      }
    } catch (e) {
      grid.replaceChildren(h("p", { class: "media-empty" }, String((e as Error).message ?? e)));
      return;
    }
    const q = search.value.trim().toLowerCase();
    const shown = q ? paths.filter((p) => p.split("/").pop()!.toLowerCase().includes(q)) : paths;
    info.textContent = `${shown.length} of ${paths.length} images`;
    grid.replaceChildren(
      ...shown.map((path) => {
        const name = path.split("/").pop()!;
        const tile = h(
          "button",
          { type: "button", class: `media-tile${selected.includes(path) ? " selected" : ""}${state.uploads.has(path) ? " pending" : ""}`, title: name },
          thumb(path),
          h("span", {}, name)
        );
        tile.addEventListener("click", () => {
          if (!opts.pick) return;
          if (opts.pick === "one") {
            chosen = [path];
            dialog.close();
            return;
          }
          const i = selected.indexOf(path);
          if (i >= 0) selected.splice(i, 1);
          else selected.push(path);
          tile.classList.toggle("selected", i < 0);
          insert.textContent = selected.length ? `Insert ${selected.length}` : "Insert";
        });
        return tile;
      })
    );
    if (!shown.length) grid.append(h("p", { class: "media-empty" }, q ? "No matches." : "No images yet. Drop some here."));
    if (opts.entry) info.textContent += " (its own: referenced, or named after it)";
  };

  for (const f of folders) {
    const b = h("button", { type: "button", "data-media": f.media, title: f.media }, f.label);
    b.addEventListener("click", () => {
      folder = f;
      render();
    });
    tabs.append(b);
  }
  search.addEventListener("input", () => render());

  const addFiles = async (files: File[]) => {
    const added = await stageUploadsTo(uploadFolder(), files, true, opts.entry?.slug);
    if (opts.pick === "many") selected.push(...added);
    if (opts.pick === "one" && added.length) {
      chosen = [added[0]];
      dialog.close();
      return;
    }
    if (opts.pick === "many") insert.textContent = selected.length ? `Insert ${selected.length}` : "Insert";
    render();
  };
  upload.addEventListener("click", async () => addFiles(await pickFiles(true)));
  fileDropTarget(grid, addFiles);
  insert.addEventListener("click", () => {
    chosen = [...selected];
    dialog.close();
  });

  const dialog = h(
    "dialog",
    { class: "modal media-modal" },
    h("div", { class: "rt-head" }, h("h2", {}, opts.pick ? "Choose image" + (opts.pick === "many" ? "s" : "") : "Media"), tabs),
    h("div", { class: "media-bar" }, search, info, upload),
    grid,
    h(
      "div",
      { class: "modal-buttons" },
      h("span", { class: "media-hint" }, "Drop files anywhere in the grid to upload them. Uploads are saved with your next Save."),
      h("button", { type: "button", on: { click: () => dialog.close() } }, opts.pick ? "Cancel" : "Close"),
      insert
    )
  ) as HTMLDialogElement;
  dialog.addEventListener("close", () => {
    dialog.remove();
    resolveResult(chosen);
  });
  document.body.append(dialog);
  dialog.showModal();
  setTimeout(() => search.focus());
  render();
  return result;
}

// ---------------------------------------------------------------- relations

function relationOptions(field: FieldConfig): Promise<Entry[]> {
  const name = field.collection!;
  let p = state.relations.get(name);
  if (!p) {
    const target = state.config.collections.find((c) => c.name === name);
    if (!target?.folder) return Promise.resolve([]);
    p = state.backend.loadFolder(target.folder).then((files) =>
      files.filter((f) => f.name.endsWith(".md")).map((f) => parseEntry(f.name, `${target.folder}/${f.name}`, f.text))
    );
    state.relations.set(name, p);
  }
  return p;
}

const relationLabel = (field: FieldConfig, e: Entry) =>
  templateValue(e, field.display_fields?.[0] ?? "title") || e.slug;

// ---------------------------------------------------------------- popovers

let openPopover: HTMLElement | undefined;
function closePopover() {
  openPopover?.remove();
  openPopover = undefined;
}
function popover(anchor: HTMLElement, content: HTMLElement) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  const pop = h("div", { class: "popover" }, content);
  pop.style.left = `${Math.min(r.left, innerWidth - 300)}px`;
  pop.style.top = `${r.bottom + 4}px`;
  document.body.append(pop);
  openPopover = pop;
  setTimeout(() => pop.querySelector<HTMLInputElement>("input")?.focus());
  return pop;
}
document.addEventListener("mousedown", (e) => {
  if (openPopover && !openPopover.contains(e.target as Node)) closePopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopover();
});

async function relationPicker(anchor: HTMLElement, entry: Entry, col: Column) {
  const list = h("div", { class: "options" }, "Loading…");
  const search = h("input", { type: "search", placeholder: "Search…" });
  popover(anchor, h("div", {}, search, list));
  const options = await relationOptions(col.field);
  const multiple = col.field.multiple !== false;
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const current: string[] = multiple ? [...(entry.data[col.key] ?? [])] : entry.data[col.key] ? [entry.data[col.key]] : [];
    list.replaceChildren(
      ...options
        .map((o) => ({ value: templateValue(o, col.field.value_field), label: relationLabel(col.field, o) }))
        .filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
        .sort((a, b) => Number(current.includes(b.value)) - Number(current.includes(a.value)) || a.label.localeCompare(b.label))
        .map((o) =>
          h(
            "label",
            { class: "option" },
            h("input", {
              type: multiple ? "checkbox" : "radio",
              checked: current.includes(o.value),
              on: {
                change: () => {
                  if (multiple) {
                    const next = current.includes(o.value) ? current.filter((v) => v !== o.value) : [...current, o.value];
                    setValue(entry, col, next);
                    render();
                  } else {
                    setValue(entry, col, o.value);
                    closePopover();
                  }
                },
              },
            }),
            h("span", {}, o.label),
            h("small", {}, o.value)
          )
        )
    );
  };
  search.addEventListener("input", render);
  render();
}

async function markdownEditor(entry: Entry, col: Column) {
  const md = await editMarkdown(entry.data[col.key] ?? "", {
    title: `${entry.data.title ?? entry.slug}: ${col.label}`,
    showImage: (path, img) => {
      const src = thumbFor(path);
      if (typeof src === "string") img.src = src;
      else src.then((u) => (img.src = u)).catch(() => img.classList.add("broken"));
    },
    uploadImages: (files) => stageUploads(col, files),
    browseImages: () => mediaBrowser({ folder: mediaFolderFor(col), pick: "many" }),
  });
  if (md !== null && md !== (entry.data[col.key] ?? "")) setValue(entry, col, md);
}

const pickerFor = (entry: Entry, col: Column, pick: "one" | "many") => ({
  folder: mediaFolderFor(col),
  pick,
  entry: col.options.entryImages ? entry : undefined,
});

/** Choose one of `paths` (the images a thumbnail number can point at). */
function imageChoicePicker(anchor: HTMLElement, paths: string[], current: number, onPick: (n: number) => void) {
  const grid = h(
    "div",
    { class: "choice-grid" },
    ...paths.map((p, i) =>
      h(
        "button",
        {
          type: "button",
          class: `choice${i + 1 === current ? " selected" : ""}`,
          title: `${i + 1}: ${p.split("/").pop()}`,
          on: { click: () => (onPick(i + 1), closePopover()) },
        },
        thumb(p),
        h("span", {}, String(i + 1))
      )
    )
  );
  popover(anchor, h("div", {}, h("p", { class: "choice-title" }, "Thumbnail"), grid));
}

// ---------------------------------------------------------------- cells

const cells = new Map<string, HTMLTableCellElement>();
const cellKey = (entry: Entry, col: Column) => `${entry.path}\u0000${col.key}`;

function refreshCell(entry: Entry, col: Column) {
  const td = cells.get(cellKey(entry, col));
  if (td) fillCell(td, entry, col);
  td?.closest("tr")?.classList.toggle("dirty", entry.dirty.size > 0);
}

/** Click-to-edit with an <input>/<textarea>; Enter (Cmd/Ctrl+Enter for text areas) saves. */
function inlineEditor(td: HTMLElement, entry: Entry, col: Column, make: () => HTMLInputElement | HTMLTextAreaElement, read: (el: any) => unknown) {
  const el = make();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) {
      const v = read(el);
      if (v !== entry.data[col.key] && !(v == null && entry.data[col.key] == null)) return setValue(entry, col, v);
    }
    fillCell(td as HTMLTableCellElement, entry, col);
  };
  el.addEventListener("blur", () => finish(true));
  el.addEventListener("keydown", (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.key === "Escape") finish(false);
    if (e.key === "Enter" && (el.tagName === "INPUT" || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finish(true);
    }
  });
  td.replaceChildren(el);
  el.focus();
  if ("select" in el) el.select();
}

function fillCell(td: HTMLTableCellElement, entry: Entry, col: Column) {
  const v = entry.data[col.key];
  td.classList.toggle("changed", entry.dirty.has(col.key));
  td.onclick = td.ondragover = td.ondragleave = td.ondrop = null;
  switch (col.kind) {
    case "computed": {
      const n = col.computed!.value(entry.data);
      td.replaceChildren(h("div", { class: "text num computed", title: "Worked out from other fields" }, n == null ? "" : col.computed!.format(n)));
      break;
    }
    case "text":
    case "longtext": {
      td.replaceChildren(h("div", { class: `text ${col.kind}` }, v == null ? "" : String(v)));
      td.onclick = () =>
        td.querySelector("input,textarea") ||
        inlineEditor(
          td,
          entry,
          col,
          () => {
            const el = col.kind === "text" ? h("input", { type: "text" }) : h("textarea", { rows: 4 });
            (el as HTMLInputElement).value = v == null ? "" : String(v);
            return el as HTMLInputElement;
          },
          (el) => (el.value.trim() === "" ? null : el.value)
        );
      break;
    }
    case "number": {
      td.replaceChildren(h("div", { class: "text num" }, v == null ? "" : String(v)));
      td.onclick = () =>
        td.querySelector("input") ||
        inlineEditor(
          td,
          entry,
          col,
          () => {
            const el = h("input", { type: "number", step: col.field.value_type === "int" ? 1 : "any" }) as HTMLInputElement;
            el.value = v == null ? "" : String(v);
            return el;
          },
          (el) => {
            if (el.value === "") return null;
            const n = col.field.value_type === "int" ? parseInt(el.value, 10) : parseFloat(el.value);
            return Number.isFinite(n) ? n : null;
          }
        );
      break;
    }
    case "boolean": {
      // A missing value means the field's default, as in Sveltia (e.g. published: true)
      const checked = v == null ? col.field.default === true : !!v;
      td.replaceChildren(
        h("input", { type: "checkbox", checked, on: { change: (e: Event) => setValue(entry, col, (e.target as HTMLInputElement).checked) } })
      );
      break;
    }
    case "select": {
      const opts = (col.field.options ?? []).map((o) => (typeof o === "object" ? o : { label: String(o), value: o }));
      const sel = h(
        "select",
        { on: { change: (e: Event) => setValue(entry, col, (e.target as HTMLSelectElement).value || null) } },
        h("option", { value: "" }, ""),
        ...opts.map((o) => h("option", { value: String(o.value), selected: String(o.value) === String(v ?? "") }, o.label))
      );
      td.replaceChildren(sel);
      break;
    }
    case "relation": {
      const values: string[] = col.field.multiple === false ? (v ? [v] : []) : Array.isArray(v) ? v : [];
      const wrap = h("div", { class: "chips" });
      const labelOf = new Map<string, string>();
      relationOptions(col.field).then((opts) => {
        for (const o of opts) labelOf.set(templateValue(o, col.field.value_field), relationLabel(col.field, o));
        wrap.querySelectorAll<HTMLElement>(".chip > span").forEach((s) => (s.textContent = labelOf.get(s.dataset.value!) ?? s.dataset.value!));
      });
      for (const val of values) {
        wrap.append(
          h(
            "span",
            { class: "chip" },
            h("span", { "data-value": val }, val),
            h("button", {
              type: "button",
              class: "x",
              title: "Remove",
              on: { click: () => setValue(entry, col, col.field.multiple === false ? null : values.filter((x) => x !== val)) },
            }, "×")
          )
        );
      }
      const add = h("button", { type: "button", class: "add", title: "Add" }, "+");
      add.addEventListener("click", () => relationPicker(add, entry, col));
      wrap.append(add);
      td.replaceChildren(wrap);
      break;
    }
    case "image": {
      const box = h("div", { class: "images single" });
      if (v) {
        box.append(
          h(
            "span",
            {
              class: "tile",
              title: "Click to choose another image",
              on: { click: async (e: Event) => { if ((e.target as HTMLElement).closest(".x")) return; const [p] = await mediaBrowser(pickerFor(entry, col, "one")); if (p) setValue(entry, col, p); } },
            },
            thumb(String(v)),
            h("button", { type: "button", class: "x", title: "Remove image", on: { click: () => setValue(entry, col, null) } }, "×")
          )
        );
      } else {
        box.append(
          h("button", {
            type: "button",
            class: "add-tile",
            title: "Drop an image, or click to choose or upload one",
            on: { click: async () => { const [p] = await mediaBrowser(pickerFor(entry, col, "one")); if (p) setValue(entry, col, p); } },
          }, "+")
        );
      }
      fileDropTarget(td, async (files) => {
        const [p] = await stageUploadsTo(mediaFolderFor(col), files.slice(0, 1), false, col.options.entryImages ? entry.slug : undefined);
        if (p) setValue(entry, col, p);
      });
      td.replaceChildren(box);
      break;
    }
    case "images": {
      const list: string[] = Array.isArray(v) ? v.map(String) : [];
      const box = h("div", { class: "images" });
      const hiddenPaths: string[] = col.options.hideIn ? (entry.data[col.options.hideIn] ?? []).map(String) : [];
      const thumbAt = col.options.thumbnailIn ? (Number(entry.data[col.options.thumbnailIn]) || 1) - 1 : -1;
      list.forEach((path, i) => {
        const img = thumb(path) as HTMLImageElement;
        tileInfo.set(img, { entry, col, index: i });
        const cleanest = col.options.cleanestIn && entry.data[col.options.cleanestIn] === path;
        const cls = ["tile", hiddenPaths.includes(path) && "is-hidden", i === thumbAt && list.length > 1 && "is-thumb", cleanest && "is-cleanest"].filter(Boolean).join(" ");
        const tile = h(
          "span",
          { class: cls, draggable: "true", title: "Drag to reorder" },
          img,
          h("button", { type: "button", class: "x", title: "Remove image", on: { click: () => setValue(entry, col, list.filter((_, j) => j !== i)) } }, "×")
        );
        tile.addEventListener("dragstart", (e: DragEvent) => {
          e.dataTransfer!.setData("text/x-image-index", String(i));
          e.dataTransfer!.effectAllowed = "move";
        });
        tile.addEventListener("dragover", (e: DragEvent) => {
          if (e.dataTransfer?.types.includes("text/x-image-index")) {
            e.preventDefault();
            tile.classList.add("drop");
          }
        });
        tile.addEventListener("dragleave", () => tile.classList.remove("drop"));
        tile.addEventListener("drop", (e: DragEvent) => {
          const from = e.dataTransfer?.getData("text/x-image-index");
          tile.classList.remove("drop");
          if (from == null || from === "") return;
          e.preventDefault();
          e.stopPropagation();
          const next = [...list];
          const [moved] = next.splice(Number(from), 1);
          next.splice(i, 0, moved);
          setValue(entry, col, next);
        });
        box.append(tile);
      });
      box.append(
        h("button", {
          type: "button",
          class: "add-tile",
          title: "Drop images, or click to choose or upload",
          on: { click: async () => { const added = await mediaBrowser(pickerFor(entry, col, "many")); if (added.length) setValue(entry, col, [...list, ...added.filter((p) => !list.includes(p))]); } },
        }, "+")
      );
      fileDropTarget(td, async (files) => {
        const added = await stageUploadsTo(mediaFolderFor(col), files, false, col.options.entryImages ? entry.slug : undefined);
        if (added.length) setValue(entry, col, [...list, ...added]);
      });
      td.replaceChildren(box);
      break;
    }
    case "imagechoice": {
      // Stored as a position in the listed image fields (1 = the first image).
      const paths = col.options.pickFrom!.flatMap((k) => {
        const x = entry.data[k];
        return Array.isArray(x) ? x.map(String) : x ? [String(x)] : [];
      });
      const n = Number(v) >= 1 && Number(v) <= paths.length ? Number(v) : 1;
      if (!paths.length) {
        td.replaceChildren(h("div", { class: "text muted", title: "No images yet" }, ""));
        break;
      }
      const box = h(
        "span",
        { class: "tile choice-cell", title: paths.length > 1 ? "Click to choose the thumbnail" : "Only one image" },
        thumb(paths[n - 1]),
        h("span", { class: "badge" }, v == null ? "1" : String(n))
      );
      if (paths.length > 1) box.addEventListener("click", () => imageChoicePicker(box, paths, n, (k) => setValue(entry, col, k === 1 ? null : k)));
      td.replaceChildren(box);
      break;
    }
    case "strings": {
      const values = readStrings(col, v);
      const wrap = h("div", { class: "chips" });
      for (const s of values) {
        wrap.append(
          h(
            "span",
            { class: "chip" },
            h("span", {}, s),
            h("button", { type: "button", class: "x", title: "Remove", on: { click: () => setValue(entry, col, writeStrings(col, values.filter((x) => x !== s))) } }, "×")
          )
        );
      }
      const add = h("button", { type: "button", class: "add", title: "Add" }, "+");
      add.addEventListener("click", () => {
        const input = h("input", { type: "text", class: "chip-input", placeholder: "Add…" }) as HTMLInputElement;
        const commitInput = () => {
          const s = input.value.trim();
          if (s && !values.includes(s)) setValue(entry, col, writeStrings(col, [...values, s]));
          else fillCell(td, entry, col);
        };
        input.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") commitInput();
          if (e.key === "Escape") fillCell(td, entry, col);
        });
        input.addEventListener("blur", commitInput);
        add.replaceWith(input);
        input.focus();
      });
      wrap.append(add);
      td.replaceChildren(wrap);
      break;
    }
    case "markdown": {
      const text = String(v ?? "").replace(/\s+/g, " ").trim();
      td.replaceChildren(h("div", { class: "text md" }, text.slice(0, 140) || ""));
      td.onclick = () => markdownEditor(entry, col);
      break;
    }
    default:
      td.replaceChildren(h("div", { class: "text muted", title: "Edit this field in Sveltia" }, v == null ? "" : JSON.stringify(v)));
  }
}

// ---------------------------------------------------------------- table

function visibleColumns() {
  const rank = (k: string) => {
    const i = state.order.indexOf(k);
    return i < 0 ? state.order.length + state.columns.findIndex((c) => c.key === k) : i;
  };
  return state.columns.filter((c) => !state.hidden.has(c.key)).sort((a, b) => rank(a.key) - rank(b.key));
}

const DEFAULT_WIDTH: Record<string, number> = {
  text: 200, longtext: 260, number: 84, boolean: 76, select: 140, relation: 240, image: 84,
  images: 280, imagechoice: 84, strings: 190, markdown: 280, unsupported: 160,
};
const widthOf = (col: Column) => state.widths[col.key] ?? Math.max(DEFAULT_WIDTH[col.kind] ?? 160, col.label.length * 8 + 28);

// ".v2": layouts saved before COLUMN_DEFAULTS existed start over once
const layoutKey = () => `atelier-table.layout.v2.${state.collection?.name}`;
function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey()) || "null");
    state.order = Array.isArray(saved?.order) ? saved.order : [...(COLUMN_DEFAULTS[state.collection!.name]?.order ?? [])];
    state.widths = saved?.widths && typeof saved.widths === "object" ? saved.widths : {};
  } catch {
    state.order = [...(COLUMN_DEFAULTS[state.collection!.name]?.order ?? [])];
    state.widths = {};
  }
}
function saveLayout() {
  try {
    localStorage.setItem(layoutKey(), JSON.stringify({ order: state.order, widths: state.widths }));
  } catch {}
}

/** Header cell: click to sort, drag to reorder, drag the right edge to resize. */
function headerCell(col: Column, colEl: HTMLTableColElement, table: HTMLTableElement) {
  const sorted = state.sort?.key === col.key ? (state.sort.dir === 1 ? " ▲" : " ▼") : "";
  const th = h("th", { class: `k-${col.kind}`, title: col.field.hint ?? col.key, draggable: "true" }, h("span", { class: "th-label" }, col.label + sorted));
  let resized = false;
  th.addEventListener("click", () => {
    if (resized) return void (resized = false);
    state.sort = state.sort?.key === col.key ? (state.sort.dir === 1 ? { key: col.key, dir: -1 } : undefined) : { key: col.key, dir: 1 };
    renderTable();
  });
  th.addEventListener("dragstart", (e: DragEvent) => {
    e.dataTransfer!.setData("text/x-column", col.key);
    e.dataTransfer!.effectAllowed = "move";
  });
  th.addEventListener("dragover", (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("text/x-column")) return;
    e.preventDefault();
    th.classList.add("drop-col");
  });
  th.addEventListener("dragleave", () => th.classList.remove("drop-col"));
  th.addEventListener("drop", (e: DragEvent) => {
    th.classList.remove("drop-col");
    const from = e.dataTransfer?.getData("text/x-column");
    if (!from || from === col.key) return;
    e.preventDefault();
    const keys = visibleColumns().map((c) => c.key).filter((k) => k !== from);
    keys.splice(keys.indexOf(col.key), 0, from);
    const hiddenKeys = state.columns.map((c) => c.key).filter((k) => !keys.includes(k));
    state.order = [...keys, ...hiddenKeys];
    saveLayout();
    renderTable();
  });
  const grip = h("span", { class: "resizer", title: "Drag to resize" });
  grip.addEventListener("dragstart", (e) => e.preventDefault());
  grip.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    th.draggable = false;
    const startX = e.clientX, startW = widthOf(col), startTable = table.offsetWidth;
    const move = (ev: MouseEvent) => {
      const w = Math.max(50, Math.round(startW + ev.clientX - startX));
      state.widths[col.key] = w;
      colEl.style.width = `${w}px`;
      table.style.width = `${startTable + w - startW}px`;
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      th.draggable = true;
      resized = true;
      setTimeout(() => (resized = false), 0);
      saveLayout();
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  });
  th.append(grip);
  return th;
}

function sortValue(entry: Entry, col: Column): string | number {
  const v = col.computed ? col.computed.value(entry.data) : entry.data[col.key];
  if (v == null || v === "") return "";
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  return String(v).toLowerCase();
}

// ---------------------------------------------------------------- facet filters

const NONE = "";

function facetColumns(): Column[] {
  const keys = FACETS[state.collection?.name ?? ""];
  if (keys) return keys.map((k) => state.columns.find((c) => c.key === k)).filter((c): c is Column => !!c);
  return state.columns.filter((c) => c.kind === "strings" || c.kind === "select" || c.kind === "relation");
}

/** Several values per entry (tags, relations): an entry must have all chosen values.
 *  One value per entry (category, select): it must have any of them. */
const isMulti = (col: Column) => col.kind === "strings" || (col.kind === "relation" && col.field.multiple !== false);

function facetValues(entry: Entry, col: Column): string[] {
  const v = entry.data[col.key];
  if (col.kind === "strings") return readStrings(col, v);
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== "").map(String);
  return v == null || v === "" ? [] : [String(v)];
}

function matchesFacets(entry: Entry, except?: string) {
  for (const col of facetColumns()) {
    const chosen = state.facets[col.key];
    if (!chosen?.size || col.key === except) continue;
    const vals = facetValues(entry, col);
    const test = (c: string) => (c === NONE ? vals.length === 0 : vals.includes(c));
    if (isMulti(col) ? ![...chosen].every(test) : ![...chosen].some(test)) return false;
  }
  return true;
}

const facetsKey = () => `atelier-table.facets.${state.collection?.name}`;
function loadFacets() {
  state.facets = {};
  try {
    const saved = JSON.parse(localStorage.getItem(facetsKey()) || "{}");
    for (const [k, v] of Object.entries(saved)) if (Array.isArray(v) && v.length) state.facets[k] = new Set(v as string[]);
  } catch {}
}
function saveFacets() {
  try {
    localStorage.setItem(facetsKey(), JSON.stringify(Object.fromEntries(Object.entries(state.facets).map(([k, v]) => [k, [...v]]))));
  } catch {}
}

/** Display labels for a column's values (relation values show the related title). */
async function facetLabels(col: Column): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (col.kind === "relation") {
    for (const o of await relationOptions(col.field)) labels.set(templateValue(o, col.field.value_field), relationLabel(col.field, o));
  }
  return labels;
}

function renderFacets() {
  const bar = $("#facets");
  bar.replaceChildren(
    ...facetColumns().map((col) => {
      const chosen = state.facets[col.key];
      const btn = h("button", { type: "button", class: `facet${chosen?.size ? " on" : ""}`, title: `Filter by ${col.label.toLowerCase()}` });
      const label = h("span", {}, col.label);
      btn.append(label);
      if (chosen?.size) {
        facetLabels(col).then((labels) => {
          const names = [...chosen].map((v) => (v === NONE ? "(none)" : labels.get(v) ?? v));
          label.textContent = `${col.label}: ${names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")}`;
        });
        btn.append(
          h("span", {
            class: "facet-x",
            title: "Clear",
            on: {
              click: (e: Event) => {
                e.stopPropagation();
                delete state.facets[col.key];
                saveFacets();
                renderFacets();
                renderTable();
              },
            },
          }, "×")
        );
      }
      btn.addEventListener("click", () => facetMenu(btn, col));
      return btn;
    })
  );
}

async function facetMenu(anchor: HTMLElement, col: Column) {
  const search = h("input", { type: "search", placeholder: `Search ${col.label.toLowerCase()}…` }) as HTMLInputElement;
  const list = h("div", { class: "options" }, "Loading…");
  const hint = h("p", { class: "facet-hint" }, isMulti(col) ? "Rows must have all the ticked values." : "Rows can have any of the ticked values.");
  popover(anchor, h("div", {}, search, hint, list));
  const labels = await facetLabels(col);
  const render = () => {
    // Counts among rows that pass the other filters.
    const counts = new Map<string, number>();
    for (const e of state.entries) {
      if (!matchesFacets(e, col.key)) continue;
      const vals = facetValues(e, col);
      if (!vals.length) counts.set(NONE, (counts.get(NONE) ?? 0) + 1);
      for (const v of new Set(vals)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const chosen = state.facets[col.key] ?? new Set<string>();
    for (const c of chosen) if (!counts.has(c)) counts.set(c, 0);
    const q = search.value.trim().toLowerCase();
    const nameOf = (v: string) => (v === NONE ? "(none)" : labels.get(v) ?? v);
    const items = [...counts.entries()]
      .filter(([v]) => !q || nameOf(v).toLowerCase().includes(q) || v.toLowerCase().includes(q))
      .sort(([a, x], [b, y]) => Number(chosen.has(b)) - Number(chosen.has(a)) || Number(a === NONE) - Number(b === NONE) || y - x || nameOf(a).localeCompare(nameOf(b)));
    list.replaceChildren(
      ...items.map(([v, n]) =>
        h(
          "label",
          { class: "option" },
          h("input", {
            type: "checkbox",
            checked: chosen.has(v),
            on: {
              change: (e: Event) => {
                const set = (state.facets[col.key] ??= new Set());
                if ((e.target as HTMLInputElement).checked) set.add(v);
                else set.delete(v);
                if (!set.size) delete state.facets[col.key];
                saveFacets();
                renderFacets();
                renderTable();
                render();
              },
            },
          }),
          h("span", {}, nameOf(v)),
          h("small", {}, String(n))
        )
      )
    );
    if (!items.length) list.append(h("p", { class: "facet-hint" }, "No matches."));
  };
  search.addEventListener("input", render);
  render();
}

function rowsToShow() {
  // Comma-separated terms must all match, each anywhere in the row: "bird, etching"
  const terms = state.filter.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  let rows = state.entries.filter((e) => matchesFacets(e));
  if (terms.length) {
    rows = rows.filter((e) => {
      const values = [e.slug, ...state.columns.map((c) => e.data[c.key])]
        .filter((v) => v != null)
        .map((v) => JSON.stringify(v).toLowerCase());
      return terms.every((t) => values.some((v) => v.includes(t)));
    });
  }
  if (state.sort) {
    const col = state.columns.find((c) => c.key === state.sort!.key);
    const dir = state.sort.dir;
    if (col) {
      rows = [...rows].sort((a, b) => {
        const x = sortValue(a, col), y = sortValue(b, col);
        if (x === "" && y !== "") return 1;
        if (y === "" && x !== "") return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
      });
    }
  }
  return rows;
}

function renderTable() {
  cells.clear();
  const cols = visibleColumns();
  const rows = rowsToShow();
  // Fixed layout with a <colgroup>, so widths are exact and resizing is cheap.
  const table = h("table", { class: "grid-table" });
  const colEls = cols.map((col) => {
    const c = h("col") as HTMLTableColElement;
    c.style.width = `${widthOf(col)}px`;
    return c;
  });
  const openCol = h("col") as HTMLTableColElement;
  openCol.style.width = "32px";
  table.style.width = `${32 + cols.reduce((sum, c) => sum + widthOf(c), 0)}px`;
  const thead = h("thead", {}, h("tr", {}, h("th", { class: "open" }, ""), ...cols.map((col, i) => headerCell(col, colEls[i], table))));
  const tbody = h("tbody");
  for (const entry of rows) {
    const tr = h(
      "tr",
      { class: entry.dirty.size ? "dirty" : "" },
      h(
        "td",
        { class: "open" },
        h("a", { href: `/admin/#/collections/${state.collection!.name}/entries/${encodeURIComponent(entry.slug)}`, target: "_blank", title: `Open ${entry.name} in Sveltia` }, "↗")
      )
    );
    for (const col of cols) {
      const td = h("td", { class: `k-${col.kind}` });
      cells.set(cellKey(entry, col), td);
      fillCell(td, entry, col);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(h("colgroup", {}, openCol, ...colEls), thead, tbody);
  $("#grid").replaceChildren(table);
  $("#count").textContent = `${rows.length} of ${state.entries.length}`;
}

// ---------------------------------------------------------------- columns menu

const hiddenKey = () => `atelier-table.hidden.v2.${state.collection?.name}`;

function loadHidden() {
  try {
    const saved = JSON.parse(localStorage.getItem(hiddenKey()) || "null");
    if (Array.isArray(saved)) {
      const hidden = new Set<string>(saved);
      // Apply each hideOnce column a single time, so it can be shown again afterwards.
      const doneKey = `${hiddenKey()}.hidden-once`;
      const done = new Set<string>(JSON.parse(localStorage.getItem(doneKey) || "[]"));
      const pending = (COLUMN_DEFAULTS[state.collection!.name]?.hideOnce ?? []).filter((k) => !done.has(k));
      if (pending.length) {
        for (const k of pending) {
          hidden.add(k);
          done.add(k);
        }
        localStorage.setItem(hiddenKey(), JSON.stringify([...hidden]));
        localStorage.setItem(doneKey, JSON.stringify([...done]));
      }
      return hidden;
    }
  } catch {}
  return new Set([
    ...state.columns.filter((c) => c.kind === "unsupported").map((c) => c.key),
    ...(COLUMN_DEFAULTS[state.collection!.name]?.hidden ?? []),
  ]);
}

function columnsMenu(anchor: HTMLElement) {
  const box = h(
    "div",
    { class: "options" },
    ...state.columns.map((c) =>
      h(
        "label",
        { class: "option" },
        h("input", {
          type: "checkbox",
          checked: !state.hidden.has(c.key),
          on: {
            change: (e: Event) => {
              if ((e.target as HTMLInputElement).checked) state.hidden.delete(c.key);
              else state.hidden.add(c.key);
              try {
                localStorage.setItem(hiddenKey(), JSON.stringify([...state.hidden]));
              } catch {}
              renderTable();
            },
          },
        }),
        h("span", {}, c.label)
      )
    )
  );
  const reset = h("button", { type: "button", class: "reset-layout" }, "Reset column order and widths");
  reset.addEventListener("click", () => {
    state.order = [];
    state.widths = {};
    saveLayout();
    renderTable();
    closePopover();
  });
  popover(anchor, h("div", {}, box, reset));
}

// ---------------------------------------------------------------- load & save

/** Settings > Parameters > Pricing, for the suggested price columns. Keeps the defaults if it can't be read. */
async function loadPricing() {
  try {
    const data = (parseYaml(await (await state.backend.readBlob(PRICING_FILE)).text()) ?? {}).pricing ?? {};
    for (const key of Object.keys(pricing) as (keyof typeof pricing)[]) {
      if (typeof data[key] === "number") pricing[key] = data[key];
    }
  } catch {}
}

async function loadCollection(name: string) {
  if (dirtyEntries().length && !confirm("Discard unsaved changes?")) {
    $<HTMLSelectElement>("#collection").value = state.collection!.name;
    return;
  }
  const collection = state.config.collections.find((c) => c.name === name)!;
  state.collection = collection;
  // The title-like column comes first, next to the open-in-Sveltia link.
  const cols = columnsOf(collection, FIELD_OPTIONS[collection.name]);
  const first = cols.findIndex((c) => c.key === "title");
  if (first > 0) cols.unshift(...cols.splice(first, 1));
  await loadPricing();
  for (const c of computedColumns(collection.name)) {
    const col: Column = { field: { name: c.key, label: c.label }, kind: "computed", key: c.key, label: c.label, options: {}, computed: c };
    const at = cols.findIndex((x) => x.key === c.after);
    cols.splice(at < 0 ? cols.length : at + 1, 0, col);
  }
  state.columns = cols;
  state.hidden = loadHidden();
  loadLayout();
  loadFacets();
  renderFacets();
  state.sort = undefined;
  state.uploads.clear();
  try {
    localStorage.setItem("atelier-table.collection", name);
  } catch {}
  const toEntries = (files: { name: string; text: string }[]) =>
    files
      .filter((f) => f.name.endsWith(".md"))
      .map((f) => parseEntry(f.name, `${collection.folder}/${f.name}`, f.text))
      .sort((a, b) => String(a.data.title ?? a.slug).localeCompare(String(b.data.title ?? b.slug)));

  // Show the cached copy straight away, then bring it up to date.
  const cached = await state.backend.cachedFolder(collection.folder!);
  if (cached?.length) {
    state.entries = toEntries(cached);
    renderTable();
    updateToolbar();
    status(`${state.entries.length} entries (cached). Checking for changes…`);
  } else {
    $("#grid").replaceChildren();
    status(`Loading ${collection.label ?? name}…`);
  }
  const fresh = await state.backend.loadFolder(collection.folder!);
  if (state.collection !== collection) return; // switched away meanwhile
  if (!cached?.length) {
    state.entries = toEntries(fresh);
    renderTable();
    updateToolbar();
    return status(`${state.entries.length} entries loaded.`);
  }
  // Merge: replace entries that changed elsewhere, unless you've already edited them
  // (saving those reports the clash rather than overwriting).
  const before = new Map(state.entries.map((e) => [e.name, e]));
  const freshNames = new Set(fresh.map((f) => f.name));
  let changed = 0;
  const merged = toEntries(fresh).map((e) => {
    const old = before.get(e.name);
    if (!old) return changed++, e;
    if (old.original === e.original) return old;
    if (old.dirty.size) return old;
    changed++;
    return e;
  });
  for (const [n, e] of before) if (!freshNames.has(n) && e.dirty.size) merged.push(e);
  const removed = [...before.keys()].filter((n) => !freshNames.has(n)).length;
  if (changed || removed) {
    state.entries = merged.sort((a, b) => String(a.data.title ?? a.slug).localeCompare(String(b.data.title ?? b.slug)));
    renderTable();
    updateToolbar();
  }
  status(changed || removed ? `${state.entries.length} entries; ${changed + removed} updated from ${state.backend.kind === "local" ? "the folder" : "GitHub"}.` : `${state.entries.length} entries, up to date.`);
}

async function save() {
  const dirty = dirtyEntries();
  if ((!dirty.length && !keptUploads().length) || state.saving) return;
  state.saving = true;
  updateToolbar();
  try {
    // Only uploads still referenced by an edited value are written.
    const used = new Set<string>();
    for (const e of dirty) for (const key of e.dirty) JSON.stringify(e.data[key] ?? null).replace(/"([^"]+)"/g, (_, s) => (used.add(s), ""));
    const changes: Change[] = [];
    for (const [publicPath, up] of state.uploads) {
      if (used.has(publicPath) || up.keep) {
        used.add(publicPath);
        changes.push({ path: up.repoPath, blob: up.blob });
      }
    }
    const images = changes.length;
    const texts = new Map(dirty.map((e) => [e, serializeEntry(e)]));
    for (const [e, text] of texts) changes.push({ path: e.path, text, original: e.original });
    const label = state.collection!.label ?? state.collection!.name;
    const message =
      dirty.length === 0
        ? `Table view: upload ${images} image${images === 1 ? "" : "s"}`
        : dirty.length === 1
          ? `Table view: update ${label} “${dirty[0].data.title ?? dirty[0].slug}”`
          : `Table view: update ${dirty.length} ${label.toLowerCase()}`;

    const result = await state.backend.save(changes, message);
    await state.backend.remember(
      state.collection!.folder!,
      [...texts].map(([e, text]) => ({ name: e.name, text }))
    );

    for (const [e, text] of texts) {
      const fresh = parseEntry(e.name, e.path, text);
      Object.assign(e, { original: text, doc: fresh.doc, body: fresh.body, data: fresh.data, dirty: new Set() });
    }
    for (const p of used) {
      const up = state.uploads.get(p);
      if (up) {
        state.thumbs[p] = up.url;
        state.uploads.delete(p);
      }
    }
    state.mediaLists.clear();
    renderTable();
    const what = [
      dirty.length && `${dirty.length} entr${dirty.length === 1 ? "y" : "ies"}`,
      images && `${images} image${images === 1 ? "" : "s"}`,
    ].filter(Boolean).join(" and ");
    if (state.backend.kind === "local") status(`Saved ${what} to the local folder. Commit and push them when you're ready.`, "ok");
    else status(`Saved ${what}. The site rebuilds in a few minutes. `, "ok", result.url ? { href: result.url, text: "View commit" } : undefined);
  } catch (err) {
    status(String((err as Error).message ?? err), "error");
  } finally {
    state.saving = false;
    updateToolbar();
  }
}

function discard() {
  if (!dirtyEntries().length && keptUploads().length) {
    if (!confirm("Discard the images waiting to be uploaded?")) return;
    state.uploads.clear();
    updateToolbar();
    return status("Uploads discarded.");
  }
  if (!confirm("Discard all unsaved changes?")) return;
  for (const e of dirtyEntries()) {
    const fresh = parseEntry(e.name, e.path, e.original);
    Object.assign(e, { doc: fresh.doc, body: fresh.body, data: fresh.data, dirty: new Set() });
  }
  state.uploads.clear();
  renderTable();
  updateToolbar();
  status("Changes discarded.");
}

// ---------------------------------------------------------------- start

/** Use whatever Sveltia is signed in with: GitHub, or its local repository folder. */
async function connectBackend(): Promise<Backend | undefined> {
  const user = sveltiaUser();
  if (user?.backendName === "github" && user.token) return githubBackend(user.token, state.repo);
  if (user?.backendName === "local") {
    if (!("showDirectoryPicker" in window)) {
      status("Local repositories need Chrome or Edge, like Sveltia's local mode.", "error");
      return;
    }
    const handle = await sveltiaFolderHandle(state.repo);
    // Reading the folder needs a click (browser rule), unless permission is still active.
    const ok = async (h: FileSystemDirectoryHandle) =>
      ((await (h as any).queryPermission({ mode: "readwrite" })) === "granted" ||
        (await (h as any).requestPermission({ mode: "readwrite" })) === "granted");
    if (handle && (await (handle as any).queryPermission({ mode: "readwrite" })) === "granted") return localBackend(handle);
    return new Promise((resolve) => {
      const allow = h("button", { type: "button", class: "primary" }, handle ? `Open local folder “${handle.name}”` : "Choose the project folder");
      allow.addEventListener("click", async () => {
        try {
          const dir = handle ?? ((await (window as any).showDirectoryPicker({ mode: "readwrite" })) as FileSystemDirectoryHandle);
          if (await ok(dir)) {
            $("#grid").replaceChildren();
            resolve(localBackend(dir));
          }
        } catch (e) {
          status(String((e as Error).message ?? e), "error");
        }
      });
      $("#grid").replaceChildren(
        h("div", { class: "connect" }, h("p", {}, "Sveltia is working with a local repository. Allow this page to use the same folder:"), allow)
      );
      status("Waiting for folder access…");
    });
  }
  status("Sign in to Sveltia first (GitHub or a local repository), then come back to this page.", "error", {
    href: "/admin/",
    text: "Open the CMS",
  });
}

async function start() {
  const config = parseYaml(await (await fetch("/admin/config.yml")).text());
  const [owner, name] = String(config.backend.repo).split("/");
  state.repo = { owner, name, branch: config.backend.branch ?? "main" };
  state.config = config;
  const backend = await connectBackend();
  if (!backend) return;
  state.backend = backend;
  $("#backend").textContent = backend.label;
  // { path: [thumbnail, preview] } (older builds: { path: thumbnail })
  const manifest: Record<string, string | [string, string]> = await fetch("/admin/thumbs.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  for (const [path, v] of Object.entries(manifest)) {
    state.thumbs[path] = Array.isArray(v) ? v[0] : v;
    if (Array.isArray(v)) state.previews[path] = v[1];
  }
  document.body.append(preview, viewer);

  const folders = (config.collections as CollectionConfig[]).filter((c) => c.folder);
  const select = $<HTMLSelectElement>("#collection");
  select.replaceChildren(...folders.map((c) => h("option", { value: c.name }, c.label ?? c.name)));
  let initial = folders[0].name;
  try {
    const saved = localStorage.getItem("atelier-table.collection");
    if (saved && folders.some((c) => c.name === saved)) initial = saved;
  } catch {}
  select.value = initial;
  select.addEventListener("change", () => loadCollection(select.value).catch((e) => status(String(e.message ?? e), "error")));
  $("#search").addEventListener("input", (e) => {
    state.filter = (e.target as HTMLInputElement).value;
    renderTable();
  });
  $("#columns").addEventListener("click", (e) => columnsMenu(e.currentTarget as HTMLElement));
  $("#media").addEventListener("click", () => {
    const c = state.collection;
    mediaBrowser({ folder: c?.media_folder ? makeFolder(c.media_folder, c.public_folder) : undefined }).then(() => updateToolbar());
  });
  $("#save").addEventListener("click", save);
  $("#discard").addEventListener("click", discard);
  addEventListener("beforeunload", (e) => {
    if (dirtyEntries().length) e.preventDefault();
  });
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      save();
    }
  });
  await loadCollection(initial);
}

start().catch((e) => status(String(e.message ?? e), "error"));
