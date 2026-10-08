// Straighten & crop: point out a painting's four corners in a photo and the page flattens it
// (a perspective warp, done in the browser) into a straight crop, then saves that as an extra
// photo of the work. Lives next to Sveltia CMS (at /admin/crop/), works with whatever Sveltia
// is signed in with (see backend.ts) and saves the picture and the work's `images` as one commit.
import { parse as parseYaml } from "yaml";
import type { Repo } from "./github";
import { githubBackend, localBackend, sveltiaFolderHandle, sveltiaUser, type Backend } from "./backend";
import { parseEntry, serializeEntry, type Entry } from "./model";

const WORKS = "src/content/works";
const MEDIA = "src/media/works";
const QUALITY = 0.9;

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

// ---------------------------------------------------------------- geometry

interface Pt {
  x: number;
  y: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** The 3x3 matrix (h0..h7, h8 = 1) taking points of `from` to the matching points of `to`. */
function homography(from: Pt[], to: Pt[]): number[] {
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c] || 1e-12;
    for (let k = c; k < 9; k++) m[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (f) for (let k = c; k < 9; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row) => row[8]);
}

/** The corners in the order the result is read: turned `turns` quarter turns clockwise. */
const turned = (q: Pt[], turns: number) => q.map((_, i) => q[(i + 4 - (turns % 4)) % 4]);

/** Size of the straightened result for these corners, before any limit. */
function naturalSize(q: Pt[]) {
  return { w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, h: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2 };
}

/** Flatten the quad of `src` (corners in the source's own pixels) into a w x h picture. */
function warp(src: ImageData, quad: Pt[], w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  const hm = homography([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], quad);
  const [a, b, c, d, e, f, g, hh] = hm;
  const s = src.data;
  const sw = src.width;
  const sh = src.height;
  const o = out.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++, i += 4) {
      const px = x + 0.5;
      const den = g * px + hh * py + 1;
      let u = (a * px + b * py + c) / den - 0.5;
      let v = (d * px + e * py + f) / den - 0.5;
      u = u < 0 ? 0 : u > sw - 1 ? sw - 1 : u;
      v = v < 0 ? 0 : v > sh - 1 ? sh - 1 : v;
      const x0 = u | 0;
      const y0 = v | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0;
      const y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = u - x0;
      const fy = v - y0;
      const p00 = (y0 * sw + x0) * 4;
      const p10 = (y0 * sw + x1) * 4;
      const p01 = (y1 * sw + x0) * 4;
      const p11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      o[i] = s[p00] * w00 + s[p10] * w10 + s[p01] * w01 + s[p11] * w11;
      o[i + 1] = s[p00 + 1] * w00 + s[p10 + 1] * w10 + s[p01 + 1] * w01 + s[p11 + 1] * w11;
      o[i + 2] = s[p00 + 2] * w00 + s[p10 + 2] * w10 + s[p01 + 2] * w01 + s[p11 + 2] * w11;
      o[i + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- state

interface Work {
  entry: Entry;
  slug: string;
  title: string;
  label: string;
}

const state = {
  backend: undefined as unknown as Backend,
  repo: { owner: "", name: "", branch: "main" } as Repo,
  works: [] as Work[],
  work: undefined as Work | undefined,
  /** path of the photo being cropped, or the name of a file opened from the computer */
  source: "",
  bmp: undefined as ImageBitmap | undefined,
  /** top left, top right, bottom right, bottom left, in the photo's pixels */
  quad: [] as Pt[],
  sel: 0,
  turns: 0,
  view: { s: 1, ox: 0, oy: 0 },
  saving: false,
};

const canvas = () => $<HTMLCanvasElement>("#canvas");
const stage = () => $("#stage");

// ---------------------------------------------------------------- source picture

/** A small copy of the photo for the live preview (made once per photo). */
let previewSource: { data: ImageData; scale: number } | undefined;

function sourceData(scale: number): ImageData {
  const bmp = state.bmp!;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

const quadKey = () => `atelier-crop.${state.source}`;

function defaultQuad(): Pt[] {
  const { width: w, height: hgt } = state.bmp!;
  const mx = w * 0.1;
  const my = hgt * 0.1;
  return [
    { x: mx, y: my },
    { x: w - mx, y: my },
    { x: w - mx, y: hgt - my },
    { x: mx, y: hgt - my },
  ];
}

function rememberQuad() {
  try {
    localStorage.setItem(quadKey(), JSON.stringify({ q: state.quad, t: state.turns }));
  } catch {}
}

async function openBitmap(blob: Blob, source: string) {
  status("Opening the photo…");
  const bmp = await createImageBitmap(blob);
  state.bmp?.close();
  state.bmp = bmp;
  state.source = source;
  previewSource = undefined;
  state.sel = 0;
  state.turns = 0;
  state.quad = defaultQuad();
  try {
    const saved = JSON.parse(localStorage.getItem(quadKey()) || "null");
    if (saved?.q?.length === 4 && saved.q.every((p: Pt) => p.x <= bmp.width * 1.01 && p.y <= bmp.height * 1.01)) {
      state.quad = saved.q;
      state.turns = saved.t || 0;
    }
  } catch {}
  $("#empty").hidden = true;
  fit();
  updateToolbar();
  status(`${bmp.width} × ${bmp.height} px`);
}

// ---------------------------------------------------------------- stage drawing

function resizeCanvas() {
  const c = canvas();
  const r = stage().getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width * dpr));
  c.height = Math.max(1, Math.round(r.height * dpr));
  draw();
}

function fit() {
  const bmp = state.bmp;
  if (!bmp) return draw();
  const r = stage().getBoundingClientRect();
  const s = Math.min(r.width / bmp.width, r.height / bmp.height) * 0.94;
  state.view = { s, ox: (r.width - bmp.width * s) / 2, oy: (r.height - bmp.height * s) / 2 };
  draw();
}

function zoomAt(sx: number, sy: number, factor: number) {
  const v = state.view;
  const s = Math.min(Math.max(v.s * factor, 0.02), 40);
  const k = s / v.s;
  state.view = { s, ox: sx - (sx - v.ox) * k, oy: sy - (sy - v.oy) * k };
  draw();
}

const toScreen = (p: Pt): Pt => ({ x: p.x * state.view.s + state.view.ox, y: p.y * state.view.s + state.view.oy });
const toImage = (x: number, y: number): Pt => ({ x: (x - state.view.ox) / state.view.s, y: (y - state.view.oy) / state.view.s });

let dragging: { kind: "corner" | "pan"; i?: number; lx: number; ly: number } | undefined;
let hovered = -1;

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    paint();
  });
}

function paint() {
  const c = canvas();
  const ctx = c.getContext("2d")!;
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  const bmp = state.bmp;
  if (!bmp) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = state.view;
  ctx.imageSmoothingEnabled = v.s < 3;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, v.ox, v.oy, bmp.width * v.s, bmp.height * v.s);

  const pts = state.quad.map(toScreen);
  // dim what's outside the corners
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, c.width / dpr, c.height / dpr);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.fillStyle = "rgb(0 0 0 / 0.38)";
  ctx.fill("evenodd");
  ctx.restore();
  // the outline, with a thin dark line under it so it shows on any picture
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgb(0 0 0 / 0.55)";
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#7fb0ff";
  ctx.stroke();

  pts.forEach((p, i) => {
    const on = i === state.sel || i === hovered;
    ctx.beginPath();
    ctx.arc(p.x, p.y, on ? 10 : 8, 0, Math.PI * 2);
    ctx.fillStyle = i === state.sel ? "#2f5bd3" : "rgb(255 255 255 / 0.9)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = i === state.sel ? "#fff" : "#2f5bd3";
    ctx.stroke();
    ctx.fillStyle = i === state.sel ? "#fff" : "#1f1d1a";
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), p.x, p.y + 0.5);
  });

  if (dragging?.kind === "corner" || hovered >= 0) paintLoupe(ctx, c.width / dpr, dragging?.i ?? hovered);
  schedulePreview();
}

/** A magnifier of the area around corner `i`, in the stage corner farthest from it. */
function paintLoupe(ctx: CanvasRenderingContext2D, stageW: number, i: number) {
  const bmp = state.bmp!;
  const q = state.quad[i];
  const size = 170;
  const onLeft = toScreen(q).x < stageW / 2;
  const x = onLeft ? stageW - size - 12 : 12;
  const y = 12;
  const zoom = Math.max(state.view.s * 4, 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  ctx.fillStyle = "#111";
  ctx.fillRect(x, y, size, size);
  ctx.translate(x + size / 2, y + size / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-q.x, -q.y);
  ctx.imageSmoothingEnabled = zoom < 3;
  ctx.drawImage(bmp, 0, 0);
  // the outline through the corner, in the same magnified space
  ctx.beginPath();
  ctx.moveTo(state.quad[0].x, state.quad[0].y);
  for (const p of state.quad.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = "#7fb0ff";
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgb(255 255 255 / 0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y + size / 2 - 9);
  ctx.lineTo(x + size / 2, y + size / 2 + 9);
  ctx.moveTo(x + size / 2 - 9, y + size / 2);
  ctx.lineTo(x + size / 2 + 9, y + size / 2);
  ctx.stroke();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);
  ctx.restore();
}

// ---------------------------------------------------------------- the result

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  setTimeout(() => {
    previewQueued = false;
    renderPreview();
  }, 30);
}

/** Output size for the current corners and limit. */
function outputSize(maxEdge: number) {
  const { w, h } = naturalSize(turned(state.quad, state.turns));
  const k = Math.min(1, maxEdge / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
}

function renderPreview() {
  const out = $<HTMLCanvasElement>("#preview");
  if (!state.bmp) {
    out.width = out.height = 10;
    $("#size").textContent = "";
    return;
  }
  const maxEdge = Number($<HTMLSelectElement>("#max").value);
  const full = outputSize(maxEdge);
  $("#size").textContent = `Result: ${full.w} × ${full.h} px`;
  const small = outputSize(560);
  if (!previewSource) {
    const bmp = state.bmp;
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    previewSource = { data: sourceData(scale), scale };
  }
  const { scale, data } = previewSource;
  const quad = turned(state.quad, state.turns).map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const img = warp(data, quad, small.w, small.h);
  out.width = small.w;
  out.height = small.h;
  out.getContext("2d")!.putImageData(img, 0, 0);
}

async function renderFull(): Promise<Blob> {
  const maxEdge = Number($<HTMLSelectElement>("#max").value);
  const { w, h, k } = outputSize(maxEdge);
  // work from a copy of the photo scaled like the result (k), so big photos shrink cleanly
  const data = sourceData(k);
  const s = data.width / state.bmp!.width;
  const quad = turned(state.quad, state.turns).map((p) => ({ x: p.x * s, y: p.y * s }));
  const img = warp(data, quad, w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", QUALITY));
  if (!blob || blob.type !== "image/webp") throw new Error("This browser can't save WebP pictures.");
  return blob;
}

// ---------------------------------------------------------------- saving

const imagesOf = (e: Entry): string[] => (Array.isArray(e.data.images) ? e.data.images.filter(Boolean).map(String) : []);

/** Where the new photo goes in `images`: just before the detail (so the detail stays last), else at the end. */
function insertAt(images: string[]) {
  const last = images[images.length - 1];
  return last && /-detail(\.[\w-]+)?\.webp(\?.*)?$/.test(last) ? images.length - 1 : images.length;
}

async function save() {
  const work = state.work;
  if (!work || !state.bmp || state.saving) return;
  state.saving = true;
  updateToolbar();
  try {
    status("Straightening…");
    const blob = await renderFull();
    const taken = new Set([...(await state.backend.listFolder(MEDIA)), ...imagesOf(work.entry).map((p) => p.split("/").pop()!)]);
    let name = `${work.slug}-crop.webp`;
    for (let i = 2; taken.has(name); i++) name = `${work.slug}-crop-${i}.webp`;
    const repoPath = `${MEDIA}/${name}`;
    const entry = work.entry;
    const images = imagesOf(entry);
    images.splice(insertAt(images), 0, `/${repoPath}`);
    entry.data.images = images;
    entry.dirty.add("images");
    const text = serializeEntry(entry);
    status("Saving…");
    const result = await state.backend.save(
      [
        { path: repoPath, blob },
        { path: entry.path, text, original: entry.original },
      ],
      `Straightened photo for ${work.title || work.slug}`
    );
    await state.backend.remember(WORKS, [{ name: entry.name, text }]);
    const fresh = parseEntry(entry.name, entry.path, text);
    Object.assign(entry, { original: text, doc: fresh.doc, body: fresh.body, data: fresh.data, dirty: new Set() });
    fillPhotos();
    if (state.backend.kind === "local") status(`Saved as ${name}. Commit and push it when you're ready.`, "ok");
    else status(`Saved as ${name}. The site rebuilds in a few minutes. `, "ok", result.url ? { href: result.url, text: "View commit" } : undefined);
  } catch (err) {
    work.entry.dirty.clear();
    work.entry.data.images = imagesOf(parseEntry(work.entry.name, work.entry.path, work.entry.original));
    status(String((err as Error).message ?? err), "error");
  } finally {
    state.saving = false;
    updateToolbar();
  }
}

function updateToolbar() {
  const save = $<HTMLButtonElement>("#save");
  save.disabled = !state.bmp || !state.work || state.saving;
  save.textContent = state.saving ? "Saving…" : state.work ? `Save as an extra photo of “${state.work.title || state.work.slug}”` : "Pick a work to save to";
}

// ---------------------------------------------------------------- choosing a work and a photo

function fillPhotos() {
  const select = $<HTMLSelectElement>("#photo");
  const work = state.work;
  const images = work ? imagesOf(work.entry) : [];
  const options = images.map((p) => h("option", { value: p }, p.split("/").pop()!));
  if (state.source && !images.includes(state.source)) options.unshift(h("option", { value: state.source }, `${state.source} (from computer)`));
  select.replaceChildren(h("option", { value: "" }, images.length ? "Choose a photo…" : "No photos yet"), ...options);
  select.value = state.source;
}

async function chooseWork(label: string) {
  const work = state.works.find((w) => w.label === label) ?? state.works.find((w) => w.slug === label || w.title.toLowerCase() === label.toLowerCase());
  if (!work) return;
  state.work = work;
  try {
    localStorage.setItem("atelier-crop.work", work.slug);
  } catch {}
  history.replaceState(null, "", `?work=${encodeURIComponent(work.slug)}`);
  $<HTMLInputElement>("#work").value = work.label;
  const images = imagesOf(work.entry);
  fillPhotos();
  updateToolbar();
  // open the main photo (the first that isn't the detail)
  const first = images.find((p) => !/-detail(\.[\w-]+)?\.webp$/.test(p)) ?? images[0];
  if (first) {
    $<HTMLSelectElement>("#photo").value = first;
    await choosePhoto(first);
  } else status("This work has no photos; open one from your computer.");
}

async function choosePhoto(path: string) {
  if (!path) return;
  try {
    status("Loading the photo…");
    await openBitmap(await state.backend.readBlob(path.replace(/^\//, "")), path);
    fillPhotos();
  } catch (err) {
    status(`Couldn't open that photo: ${String((err as Error).message ?? err)}`, "error");
  }
}

async function openFile(file: File | undefined) {
  if (!file || !file.type.startsWith("image/")) return;
  try {
    await openBitmap(file, file.name);
    fillPhotos();
  } catch (err) {
    status(`Couldn't open that file: ${String((err as Error).message ?? err)}`, "error");
  }
}

// ---------------------------------------------------------------- pointer, wheel and keys

function wire() {
  const c = canvas();
  const at = (e: PointerEvent | WheelEvent) => {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nearest = (x: number, y: number) => {
    let best = -1;
    let bd = 16;
    state.quad.forEach((q, i) => {
      const p = toScreen(q);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  c.addEventListener("pointerdown", (e) => {
    if (!state.bmp) return;
    const { x, y } = at(e);
    c.setPointerCapture(e.pointerId);
    stage().focus({ preventScroll: true });
    const i = nearest(x, y);
    if (i >= 0) {
      state.sel = i;
      dragging = { kind: "corner", i, lx: x, ly: y };
    } else dragging = { kind: "pan", lx: x, ly: y };
    draw();
  });
  c.addEventListener("pointermove", (e) => {
    if (!state.bmp) return;
    const { x, y } = at(e);
    if (!dragging) {
      const i = nearest(x, y);
      if (i !== hovered) {
        hovered = i;
        c.style.cursor = i >= 0 ? "crosshair" : "grab";
        draw();
      }
      return;
    }
    if (dragging.kind === "corner") {
      const p = toImage(x, y);
      state.quad[dragging.i!] = {
        x: Math.min(Math.max(p.x, 0), state.bmp.width),
        y: Math.min(Math.max(p.y, 0), state.bmp.height),
      };
    } else {
      state.view.ox += x - dragging.lx;
      state.view.oy += y - dragging.ly;
    }
    dragging.lx = x;
    dragging.ly = y;
    draw();
  });
  const end = () => {
    if (dragging?.kind === "corner") rememberQuad();
    dragging = undefined;
    draw();
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
  c.addEventListener("pointerleave", () => {
    if (!dragging && hovered >= 0) {
      hovered = -1;
      draw();
    }
  });
  c.addEventListener(
    "wheel",
    (e) => {
      if (!state.bmp) return;
      e.preventDefault();
      const { x, y } = at(e);
      zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    },
    { passive: false }
  );
  stage().addEventListener("keydown", (e) => {
    if (!state.bmp) return;
    if (/^[1-4]$/.test(e.key)) {
      state.sel = Number(e.key) - 1;
      return draw();
    }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const q = state.quad[state.sel];
    state.quad[state.sel] = {
      x: Math.min(Math.max(q.x + d[0], 0), state.bmp.width),
      y: Math.min(Math.max(q.y + d[1], 0), state.bmp.height),
    };
    hovered = state.sel;
    rememberQuad();
    draw();
  });
  stage().addEventListener("keyup", () => {
    hovered = -1;
    draw();
  });
  const drop = stage();
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("drop");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drop"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drop");
    openFile(e.dataTransfer?.files[0]);
  });
  new ResizeObserver(resizeCanvas).observe(stage());
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
            $("#empty").hidden = false;
            resolve(localBackend(dir));
          }
        } catch (e) {
          status(String((e as Error).message ?? e), "error");
        }
      });
      $("#empty").replaceChildren(h("span", {}, "Sveltia is working with a local repository. Allow this page to use the same folder: "), allow);
      $("#empty").style.pointerEvents = "auto";
      status("Waiting for folder access…");
    });
  }
  status("Sign in to Sveltia first (GitHub or a local repository), then come back to this page.", "error", { href: "/admin/", text: "Open the CMS" });
}

async function start() {
  // the picture side works with no sign-in: a photo from the computer can still be straightened
  wire();
  resizeCanvas();
  $("#open").addEventListener("click", () => {
    const input = h("input", { type: "file", accept: "image/*" }) as HTMLInputElement;
    input.addEventListener("change", () => openFile(input.files?.[0]));
    input.click();
  });
  $("#photo").addEventListener("change", (e) => choosePhoto((e.target as HTMLSelectElement).value));
  $("#fit").addEventListener("click", fit);
  $("#actual").addEventListener("click", () => {
    const r = stage().getBoundingClientRect();
    if (state.bmp) zoomAt(r.width / 2, r.height / 2, 1 / state.view.s);
  });
  $("#reset").addEventListener("click", () => {
    if (!state.bmp) return;
    state.quad = defaultQuad();
    state.turns = 0;
    rememberQuad();
    draw();
  });
  $("#rot-l").addEventListener("click", () => ((state.turns = (state.turns + 3) % 4), rememberQuad(), draw()));
  $("#rot-r").addEventListener("click", () => ((state.turns = (state.turns + 1) % 4), rememberQuad(), draw()));
  $("#max").addEventListener("change", schedulePreview);
  $("#save").addEventListener("click", save);
  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    if (e.key === "f") fit();
  });

  const config = parseYaml(await (await fetch("/admin/config.yml")).text());
  const [owner, name] = String(config.backend.repo).split("/");
  state.repo = { owner, name, branch: config.backend.branch ?? "main" };
  const backend = await connectBackend();
  if (!backend) return;
  state.backend = backend;
  $("#backend").textContent = backend.label;

  status("Loading the works…");
  const files = await backend.loadFolder(WORKS);
  state.works = files
    .filter((f) => f.name.endsWith(".md"))
    .map((f) => parseEntry(f.name, `${WORKS}/${f.name}`, f.text))
    .map((entry) => {
      const title = String(entry.data.title ?? "");
      return { entry, slug: entry.slug, title, label: `${title && title !== "null" ? title : "No title recorded"} — ${entry.slug}` };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  $("#works").replaceChildren(...state.works.map((w) => h("option", { value: w.label })));
  $("#work").addEventListener("change", (e) => chooseWork((e.target as HTMLInputElement).value));
  status("");
  updateToolbar();

  let wanted = new URLSearchParams(location.search).get("work");
  try {
    wanted ??= localStorage.getItem("atelier-crop.work");
  } catch {}
  const w = state.works.find((x) => x.slug === wanted);
  if (w) await chooseWork(w.label);
}

start().catch((e) => status(String(e.message ?? e), "error"));
