// Drag-and-drop order of the works in a collection. Lives next to Sveltia CMS (at
// /admin/order/), works with whatever Sveltia is signed in with (see backend.ts) and
// saves the collection's `order` (work slugs) and `sort: manual` as one commit.
import { parse as parseYaml } from "yaml";
import type { Repo } from "./github";
import { githubBackend, localBackend, sveltiaFolderHandle, sveltiaUser, type Backend } from "./backend";
import { parseEntry, serializeEntry, type Entry } from "./model";

const COLLECTIONS = "src/content/collections";
const WORKS = "src/content/works";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function h(tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string | null | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn as EventListener);
    else if (k === "class") el.className = String(v);
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}

function status(text: string, kind = "", link?: { href: string; text: string }) {
  const el = $("#status");
  el.className = `status ${kind}`;
  el.textContent = text;
  if (link) el.append(" ", h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text));
}

interface Work {
  entry: Entry;
  slug: string;
  title: string;
  year: number;
  /** path of the picture used in grids (the site's own rule: thumbnail number, hidden ones skipped) */
  image?: string;
  off?: string;
}

const state = {
  backend: undefined as unknown as Backend,
  repo: { owner: "", name: "", branch: "main" } as Repo,
  collections: [] as Entry[],
  works: [] as Work[],
  current: undefined as Entry | undefined,
  /** slugs in the order shown */
  order: [] as string[],
  /** the order as saved, to tell whether anything changed */
  saved: [] as string[],
  sortWasManual: false,
  thumbs: {} as Record<string, string>,
  saving: false,
};

const byTitle = (a: Work, b: Work) => (a.title ? 0 : 1) - (b.title ? 0 : 1) || a.title.localeCompare(b.title);

function toWork(entry: Entry): Work {
  const d = entry.data;
  const all: string[] = (Array.isArray(d.images) ? d.images : []).filter(Boolean).map(String);
  const hidden = new Set<string>((Array.isArray(d.hidden_images) ? d.hidden_images : []).map(String));
  const shown = all.filter((p) => !hidden.has(p));
  const n = Number(d.thumbnail);
  const chosen = n >= 1 ? all[n - 1] : undefined;
  const image = (chosen && shown.includes(chosen) ? chosen : shown[0]) ?? (all.length ? undefined : d.old_image);
  const off = d.published === false ? "Unpublished" : !image ? "No image" : undefined;
  return { entry, slug: entry.slug, title: String(d.title ?? ""), year: Number(d.year_start) || 0, image, off };
}

/** The saved order for the collection's works (those missing from it follow, by title: as on the site). */
function orderFor(col: Entry, members: Work[]): string[] {
  const saved: string[] = Array.isArray(col.data.order) ? col.data.order.map(String) : [];
  const have = new Set(members.map((w) => w.slug));
  const placed = saved.filter((s, i) => have.has(s) && saved.indexOf(s) === i);
  const rest = members.filter((w) => !placed.includes(w.slug)).sort(byTitle).map((w) => w.slug);
  return [...placed, ...rest];
}

const membersOf = (col: Entry) => state.works.filter((w) => (w.entry.data.collections ?? []).includes(col.slug));

// ---------------------------------------------------------------- thumbnails

let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function shrink(blob: Blob, max = 480): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
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

const rawThumbs = new Map<string, Promise<string>>();
function thumbFor(path: string): string | Promise<string> {
  const built = state.thumbs[path];
  if (built) return built;
  let p = rawThumbs.get(path);
  if (!p) {
    p = limited(async () => URL.createObjectURL(await shrink(await state.backend.readBlob(path.replace(/^\//, "")))));
    rawThumbs.set(path, p);
  }
  return p;
}

// ---------------------------------------------------------------- grid

const bySlug = () => new Map(state.works.map((w) => [w.slug, w]));
const moved = new Set<string>();

function updateToolbar() {
  const dirty = !!state.current && moved.size > 0;
  const save = $<HTMLButtonElement>("#save");
  save.disabled = !dirty || state.saving;
  save.textContent = state.saving ? "Saving…" : dirty ? "Save order" : "Saved";
  $("#discard").hidden = !dirty;
  $("#count").textContent = state.current ? `${state.order.length} works` : "";
}

function renumber() {
  [...$("#grid").children].forEach((tile, i) => {
    const num = tile.querySelector("b");
    if (num) num.textContent = `${i + 1}.`;
  });
}

function render() {
  const grid = $("#grid");
  const works = bySlug();
  grid.replaceChildren(
    ...state.order.map((slug) => {
      const w = works.get(slug)!;
      const img = h("img", { alt: "", loading: "lazy", draggable: "false" }) as HTMLImageElement;
      if (w.image) {
        const src = thumbFor(w.image);
        if (typeof src === "string") img.src = src;
        else src.then((u) => (img.src = u)).catch(() => {});
      }
      const tile = h(
        "div",
        { class: `tile${w.off ? " off" : ""}${moved.has(slug) ? " moved" : ""}`, draggable: "true", "data-slug": slug, title: w.title },
        h("div", { class: "pic" }, img),
        h("div", { class: "name" }, h("b", {}, ""), w.title || "No title recorded"),
        w.off && h("span", { class: "badge" }, w.off),
        h(
          "span",
          { class: "go" },
          h("button", { type: "button", title: "Move to the start", on: { click: () => place(slug, 0) } }, "⤒ top"),
          h("button", { type: "button", title: "Move to the end", on: { click: () => place(slug, Infinity) } }, "end ⤓")
        )
      );
      return tile;
    })
  );
  renumber();
  updateToolbar();
}

function place(slug: string, to: number) {
  const rest = state.order.filter((s) => s !== slug);
  rest.splice(Math.min(to, rest.length), 0, slug);
  state.order = rest;
  moved.add(slug);
  render();
  document.querySelector(`[data-slug="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: "nearest" });
}

// Dragging moves the tile in the DOM as you go; the order is read back when you drop.
let dragging: HTMLElement | null = null;
function wireDrag() {
  const grid = $("#grid");
  grid.addEventListener("dragstart", (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>(".tile");
    if (!tile) return;
    dragging = tile;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", tile.dataset.slug ?? "");
    requestAnimationFrame(() => tile.classList.add("dragging"));
  });
  grid.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const over = (e.target as HTMLElement).closest<HTMLElement>(".tile");
    if (!over || over === dragging) return;
    const box = over.getBoundingClientRect();
    // Land after the tile when the pointer is in its right half, before it otherwise.
    const after = e.clientX > box.left + box.width / 2;
    grid.insertBefore(dragging, after ? over.nextSibling : over);
    renumber();
  });
  grid.addEventListener("drop", (e) => e.preventDefault());
  grid.addEventListener("dragend", () => {
    if (!dragging) return;
    dragging.classList.remove("dragging");
    const next = [...grid.children].map((t) => (t as HTMLElement).dataset.slug!);
    if (next.join("\n") !== state.order.join("\n")) {
      moved.add(dragging.dataset.slug!);
      dragging.classList.add("moved");
      state.order = next;
    }
    dragging = null;
    updateToolbar();
  });
}

// ---------------------------------------------------------------- collections

function openCollection(slug: string) {
  const col = state.collections.find((c) => c.slug === slug);
  if (!col) return;
  try {
    localStorage.setItem("atelier-order.collection", slug);
  } catch {}
  state.current = col;
  state.sortWasManual = col.data.sort === "manual";
  const members = membersOf(col);
  state.order = orderFor(col, members);
  // "saved" is what the site shows now: the order only counts once sort is manual
  state.saved = state.sortWasManual ? [...state.order] : [];
  moved.clear();
  $("#hint").textContent = members.length
    ? `Drag works to reorder them. Hover a work for “to top” / “to end”. Saving also sets ${col.data.title ?? col.slug}'s Sort to Manually.`
    : "No works in this collection yet (add them from a work's Collections field).";
  render();
  if (!state.sortWasManual) status(`${col.data.title ?? col.slug} is sorted by title on the site until you save.`);
  else status("");
}

function startOver(by: "title" | "newest" | "oldest") {
  if (!state.current) return;
  if (moved.size && !confirm("Replace your current arrangement with this order?")) return;
  const members = membersOf(state.current);
  const year = (w: Work) => w.year;
  const cmp =
    by === "newest"
      ? (a: Work, b: Work) => year(b) - year(a) || byTitle(a, b)
      : by === "oldest"
        ? (a: Work, b: Work) => (year(a) || 9999) - (year(b) || 9999) || byTitle(a, b)
        : byTitle;
  state.order = [...members].sort(cmp).map((w) => w.slug);
  state.order.forEach((s) => moved.add(s));
  render();
}

async function save() {
  const col = state.current;
  if (!col || state.saving) return;
  state.saving = true;
  updateToolbar();
  try {
    // Keep the slugs of works this page can't see (e.g. renamed since) out: only current members are saved.
    col.data.order = state.order;
    col.data.sort = "manual";
    col.dirty.add("order").add("sort");
    const text = serializeEntry(col);
    const title = col.data.title ?? col.slug;
    const result = await state.backend.save([{ path: col.path, text, original: col.original }], `Collection order: ${title}`);
    await state.backend.remember(COLLECTIONS, [{ name: col.name, text }]);
    const fresh = parseEntry(col.name, col.path, text);
    Object.assign(col, { original: text, doc: fresh.doc, body: fresh.body, data: fresh.data, dirty: new Set() });
    state.saved = [...state.order];
    state.sortWasManual = true;
    moved.clear();
    render();
    if (state.backend.kind === "local") status("Saved to the local folder. Commit and push it when you're ready.", "ok");
    else status("Saved. The site rebuilds in a few minutes. ", "ok", result.url ? { href: result.url, text: "View commit" } : undefined);
  } catch (err) {
    col.dirty.clear();
    status(String((err as Error).message ?? err), "error");
  } finally {
    state.saving = false;
    updateToolbar();
  }
}

function discard() {
  if (!state.current || !confirm("Discard the changes to this order?")) return;
  openCollection(state.current.slug);
}

// ---------------------------------------------------------------- start

async function connectBackend(): Promise<Backend | undefined> {
  const user = sveltiaUser();
  if (user?.backendName === "github" && user.token) return githubBackend(user.token, state.repo);
  if (user?.backendName === "local") {
    if (!("showDirectoryPicker" in window)) {
      status("Local repositories need Chrome or Edge, like Sveltia's local mode.", "error");
      return;
    }
    const handle = await sveltiaFolderHandle(state.repo);
    const granted = async (d: FileSystemDirectoryHandle) =>
      (await (d as any).queryPermission({ mode: "readwrite" })) === "granted" ||
      (await (d as any).requestPermission({ mode: "readwrite" })) === "granted";
    if (handle && (await (handle as any).queryPermission({ mode: "readwrite" })) === "granted") return localBackend(handle);
    return new Promise((resolve) => {
      const allow = h("button", { type: "button", class: "primary" }, handle ? `Open local folder “${handle.name}”` : "Choose the project folder");
      allow.addEventListener("click", async () => {
        try {
          const dir = handle ?? ((await (window as any).showDirectoryPicker({ mode: "readwrite" })) as FileSystemDirectoryHandle);
          if (await granted(dir)) {
            $("#grid").replaceChildren();
            resolve(localBackend(dir));
          }
        } catch (e) {
          status(String((e as Error).message ?? e), "error");
        }
      });
      $("#grid").replaceChildren(h("div", { class: "connect" }, h("p", {}, "Sveltia is working with a local repository. Allow this page to use the same folder:"), allow));
      status("Waiting for folder access…");
    });
  }
  status("Sign in to Sveltia first (GitHub or a local repository), then come back to this page.", "error", { href: "/admin/", text: "Open the CMS" });
}

const toEntries = (folder: string, files: { name: string; text: string }[]) =>
  files.filter((f) => f.name.endsWith(".md")).map((f) => parseEntry(f.name, `${folder}/${f.name}`, f.text));

async function start() {
  const config = parseYaml(await (await fetch("/admin/config.yml")).text());
  const [owner, name] = String(config.backend.repo).split("/");
  state.repo = { owner, name, branch: config.backend.branch ?? "main" };
  const backend = await connectBackend();
  if (!backend) return;
  state.backend = backend;
  $("#backend").textContent = backend.label;

  const manifest: Record<string, string | [string, string]> = await fetch("/admin/thumbs.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  for (const [path, v] of Object.entries(manifest)) state.thumbs[path] = Array.isArray(v) ? v[0] : v;

  status("Loading…");
  const [cols, works] = await Promise.all([backend.loadFolder(COLLECTIONS), backend.loadFolder(WORKS)]);
  state.collections = toEntries(COLLECTIONS, cols).sort((a, b) => String(a.data.title ?? a.slug).localeCompare(String(b.data.title ?? b.slug)));
  state.works = toEntries(WORKS, works).map(toWork);

  const select = $<HTMLSelectElement>("#collection");
  select.replaceChildren(
    ...state.collections.map((c) => h("option", { value: c.slug }, `${c.data.title ?? c.slug} (${membersOf(c).length})`))
  );
  let initial = state.collections[0]?.slug;
  const wanted = new URLSearchParams(location.search).get("collection");
  try {
    initial = wanted ?? localStorage.getItem("atelier-order.collection") ?? initial;
  } catch {}
  if (!state.collections.some((c) => c.slug === initial)) initial = state.collections[0]?.slug;
  select.value = initial;
  select.addEventListener("change", () => {
    if (moved.size && !confirm("Leave this collection and lose its unsaved order?")) return (select.value = state.current!.slug);
    openCollection(select.value);
  });
  $("#size").addEventListener("input", (e) => document.documentElement.style.setProperty("--size", `${(e.target as HTMLInputElement).value}px`));
  $("#by-title").addEventListener("click", () => startOver("title"));
  $("#by-newest").addEventListener("click", () => startOver("newest"));
  $("#by-oldest").addEventListener("click", () => startOver("oldest"));
  $("#save").addEventListener("click", save);
  $("#discard").addEventListener("click", discard);
  addEventListener("beforeunload", (e) => {
    if (moved.size) e.preventDefault();
  });
  wireDrag();
  openCollection(initial);
}

start().catch((e) => status(String(e.message ?? e), "error"));
