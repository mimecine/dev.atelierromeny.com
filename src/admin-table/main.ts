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

// ---------------------------------------------------------------- state

interface Upload {
  blob: Blob;
  url: string;
  repoPath: string;
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
  sort: undefined as { key: string; dir: 1 | -1 } | undefined,
  uploads: new Map<string, Upload>(),
  thumbs: {} as Record<string, string>,
  rawThumbs: new Map<string, Promise<string>>(),
  relations: new Map<string, Promise<Entry[]>>(),
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

function updateToolbar() {
  const n = dirtyEntries().length;
  const save = $<HTMLButtonElement>("#save");
  save.disabled = n === 0 || state.saving;
  save.textContent = state.saving ? "Saving…" : n ? `Save ${n} change${n === 1 ? "" : "s"}` : "Saved";
  $<HTMLButtonElement>("#discard").hidden = n === 0 || state.saving;
}

function setValue(entry: Entry, col: Column, value: unknown) {
  entry.data[col.key] = value;
  entry.dirty.add(col.key);
  updateToolbar();
  refreshCell(entry, col);
}

// ---------------------------------------------------------------- media

function mediaFolders(col: Column) {
  const c = state.collection!;
  const media = col.field.field?.media_folder ?? col.field.media_folder ?? c.media_folder ?? state.config.media_folder ?? "src/media";
  const pub = col.field.field?.public_folder ?? col.field.public_folder ?? c.public_folder ?? state.config.public_folder ?? `/${stripSlash(media)}`;
  return { media: stripSlash(media), pub: pub.replace(/\/+$/, "") };
}

async function stageUploads(col: Column, files: File[]): Promise<string[]> {
  const { media, pub } = mediaFolders(col);
  const paths: string[] = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    status(`Preparing ${file.name}…`);
    const { blob, ext } = await prepareUpload(file);
    const base = slugifyBase(file.name);
    let name = `${base}.${ext}`;
    for (let i = 2; state.thumbs[`${pub}/${name}`] || state.uploads.has(`${pub}/${name}`); i++) name = `${base}-${i}.${ext}`;
    const publicPath = `${pub}/${name}`;
    state.uploads.set(publicPath, { blob, url: URL.createObjectURL(blob), repoPath: `${media}/${name}` });
    paths.push(publicPath);
  }
  status(paths.length ? `${paths.length} image${paths.length === 1 ? "" : "s"} ready; they're uploaded when you save.` : "No images in that drop.");
  return paths;
}

/** Thumbnail URL for a stored path: a pending upload, the build's thumbnail, or GitHub. */
function thumbFor(path: string): string | Promise<string> {
  const up = state.uploads.get(path);
  if (up) return up.url;
  const built = state.thumbs[path];
  if (built) return built;
  let p = state.rawThumbs.get(path);
  if (!p) {
    p = state.backend.readBlob(stripSlash(path)).then((b) => URL.createObjectURL(b));
    state.rawThumbs.set(path, p);
  }
  return p;
}

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

function thumb(path: string, extra: Attrs = {}) {
  const img = h("img", { class: "thumb", alt: "", title: path.split("/").pop(), "data-path": path, ...extra });
  const src = state.uploads.get(path)?.url ?? state.thumbs[path];
  if (src) img.src = src;
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
  });
  if (md !== null && md !== (entry.data[col.key] ?? "")) setValue(entry, col, md);
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
  el.addEventListener("keydown", (e: KeyboardEvent) => {
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
            { class: "tile" },
            thumb(String(v)),
            h("button", { type: "button", class: "x", title: "Remove image", on: { click: () => setValue(entry, col, null) } }, "×")
          )
        );
      } else {
        box.append(
          h("button", {
            type: "button",
            class: "add-tile",
            title: "Drop an image or click to choose",
            on: { click: async () => { const [p] = await stageUploads(col, (await pickFiles(false)).slice(0, 1)); if (p) setValue(entry, col, p); } },
          }, "+")
        );
      }
      fileDropTarget(td, async (files) => {
        const [p] = await stageUploads(col, files.slice(0, 1));
        if (p) setValue(entry, col, p);
      });
      td.replaceChildren(box);
      break;
    }
    case "images": {
      const list: string[] = Array.isArray(v) ? v.map(String) : [];
      const box = h("div", { class: "images" });
      list.forEach((path, i) => {
        const tile = h(
          "span",
          { class: "tile", draggable: "true", title: "Drag to reorder" },
          thumb(path),
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
          title: "Drop images or click to choose",
          on: { click: async () => { const added = await stageUploads(col, await pickFiles(true)); if (added.length) setValue(entry, col, [...list, ...added]); } },
        }, "+")
      );
      fileDropTarget(td, async (files) => {
        const added = await stageUploads(col, files);
        if (added.length) setValue(entry, col, [...list, ...added]);
      });
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
  return state.columns.filter((c) => !state.hidden.has(c.key));
}

function sortValue(entry: Entry, col: Column): string | number {
  const v = entry.data[col.key];
  if (v == null || v === "") return "";
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  return String(v).toLowerCase();
}

function rowsToShow() {
  const q = state.filter.trim().toLowerCase();
  let rows = state.entries;
  if (q) {
    rows = rows.filter((e) =>
      [e.slug, ...state.columns.map((c) => e.data[c.key])].some((v) => v != null && JSON.stringify(v).toLowerCase().includes(q))
    );
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
  const thead = h(
    "thead",
    {},
    h(
      "tr",
      {},
      h("th", { class: "open" }, ""),
      ...cols.map((col) => {
        const sorted = state.sort?.key === col.key ? (state.sort.dir === 1 ? " ▲" : " ▼") : "";
        return h(
          "th",
          {
            class: `k-${col.kind}`,
            title: col.field.hint ?? col.key,
            on: {
              click: () => {
                state.sort = state.sort?.key === col.key ? (state.sort.dir === 1 ? { key: col.key, dir: -1 } : undefined) : { key: col.key, dir: 1 };
                renderTable();
              },
            },
          },
          col.label + sorted
        );
      })
    )
  );
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
  $("#grid").replaceChildren(h("table", {}, thead, tbody));
  $("#count").textContent = `${rows.length} of ${state.entries.length}`;
}

// ---------------------------------------------------------------- columns menu

const hiddenKey = () => `atelier-table.hidden.${state.collection?.name}`;

function loadHidden() {
  try {
    const saved = JSON.parse(localStorage.getItem(hiddenKey()) || "null");
    if (Array.isArray(saved)) return new Set<string>(saved);
  } catch {}
  return new Set(state.columns.filter((c) => c.kind === "unsupported").map((c) => c.key));
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
  popover(anchor, box);
}

// ---------------------------------------------------------------- load & save

async function loadCollection(name: string) {
  if (dirtyEntries().length && !confirm("Discard unsaved changes?")) {
    $<HTMLSelectElement>("#collection").value = state.collection!.name;
    return;
  }
  const collection = state.config.collections.find((c) => c.name === name)!;
  state.collection = collection;
  // The title-like column comes first, next to the open-in-Sveltia link.
  const cols = columnsOf(collection);
  const first = cols.findIndex((c) => c.key === "title");
  if (first > 0) cols.unshift(...cols.splice(first, 1));
  state.columns = cols;
  state.hidden = loadHidden();
  state.sort = undefined;
  state.uploads.clear();
  status(`Loading ${collection.label ?? name}…`);
  $("#grid").replaceChildren();
  const files = await state.backend.loadFolder(collection.folder!);
  state.entries = files
    .filter((f) => f.name.endsWith(".md"))
    .map((f) => parseEntry(f.name, `${collection.folder}/${f.name}`, f.text))
    .sort((a, b) => String(a.data.title ?? a.slug).localeCompare(String(b.data.title ?? b.slug)));
  try {
    localStorage.setItem("atelier-table.collection", name);
  } catch {}
  renderTable();
  updateToolbar();
  status(`${state.entries.length} entries loaded.`);
}

async function save() {
  const dirty = dirtyEntries();
  if (!dirty.length || state.saving) return;
  state.saving = true;
  updateToolbar();
  try {
    // Only uploads still referenced by an edited value are written.
    const used = new Set<string>();
    for (const e of dirty) for (const key of e.dirty) JSON.stringify(e.data[key] ?? null).replace(/"([^"]+)"/g, (_, s) => (used.add(s), ""));
    const changes: Change[] = [];
    for (const [publicPath, up] of state.uploads) if (used.has(publicPath)) changes.push({ path: up.repoPath, blob: up.blob });
    const texts = new Map(dirty.map((e) => [e, serializeEntry(e)]));
    for (const [e, text] of texts) changes.push({ path: e.path, text, original: e.original });
    const label = state.collection!.label ?? state.collection!.name;
    const message =
      dirty.length === 1
        ? `Table view: update ${label} “${dirty[0].data.title ?? dirty[0].slug}”`
        : `Table view: update ${dirty.length} ${label.toLowerCase()}`;

    const result = await state.backend.save(changes, message);

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
    renderTable();
    const what = `${dirty.length} entr${dirty.length === 1 ? "y" : "ies"}`;
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
  state.thumbs = await fetch("/admin/thumbs.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));

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
