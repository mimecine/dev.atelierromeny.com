// The corner-pointing cropper, shared by /admin/crop/ and the table view's Detail column.
// Point out a painting's four corners in a photo and it is flattened (a perspective warp
// done in the browser) into a straight crop; the host decides where the result goes.
import "./cropper.css";

const QUALITY = 0.9;

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


// ---------------------------------------------------------------- component

export interface CropAction {
  label: string;
  primary?: boolean;
  /** Receives the straightened picture; throw to show an error. */
  run(blob: Blob): Promise<void> | void;
}

export interface CropperOptions {
  /** Stable name of the photo, used to remember its corners */
  readPhoto(path: string): Promise<Blob>;
  actions: CropAction[];
}

export interface Cropper {
  el: HTMLElement;
  /** The photos offered in the Photo menu */
  setPhotos(paths: string[], open?: string): void;
  openBlob(blob: Blob, source: string): Promise<void>;
  setStatus(text: string, kind?: string, link?: { href: string; text: string }): void;
  /** Call after the element is in the page (and when its size changes) */
  layout(): void;
  destroy(): void;
}

export function createCropper(opts: CropperOptions): Cropper {
  const st = {
    bmp: undefined as ImageBitmap | undefined,
    source: "",
    quad: [] as Pt[],
    sel: 0,
    turns: 0,
    view: { s: 1, ox: 0, oy: 0 },
    busy: false,
  };
  let previewSource: { data: ImageData; scale: number } | undefined;

  const photo = h("select", { class: "cr-photo", title: "Photo to straighten" }) as HTMLSelectElement;
  const openBtn = h("button", { type: "button", title: "Use a photo from your computer (or drop one on the picture)" }, "Open file…");
  const statusEl = h("span", { class: "cr-status" });
  const canvas = h("canvas", { class: "cr-canvas" }) as HTMLCanvasElement;
  const empty = h("p", { class: "cr-empty" }, "Choose a photo, or drop one here.");
  const stage = h("div", { class: "cr-stage", tabindex: "0" }, canvas, empty);
  const preview = h("canvas", { width: "10", height: "10" }) as HTMLCanvasElement;
  const sizeEl = h("p", { class: "cr-size" });
  const maxSel = h(
    "select",
    {},
    ...[1500, 2000, 3000, 4000, 6000].map((n) => h("option", { value: String(n), ...(n === 3000 ? { selected: "" } : {}) }, String(n)))
  ) as HTMLSelectElement;
  const btn = (label: string, title: string, fn: () => void, cls = "") => h("button", { type: "button", title, class: cls, on: { click: fn } }, label);
  const actionBtns = opts.actions.map((a) =>
    h("button", {
      type: "button",
      class: a.primary ? "primary" : "",
      on: {
        click: async () => {
          if (!st.bmp || st.busy) return;
          st.busy = true;
          syncButtons();
          try {
            setStatus("Straightening…");
            const blob = await renderFull();
            await a.run(blob);
          } catch (err) {
            setStatus(String((err as Error).message ?? err), "error");
          } finally {
            st.busy = false;
            syncButtons();
          }
        },
      },
    }, a.label) as HTMLButtonElement
  );
  const syncButtons = () => actionBtns.forEach((b) => (b.disabled = !st.bmp || st.busy));
  syncButtons();

  const side = h(
    "aside",
    { class: "cr-side" },
    h("div", { class: "cr-preview" }, preview),
    sizeEl,
    h("div", { class: "cr-row" },
      btn("⟲", "Turn the result a quarter turn anticlockwise", () => ((st.turns = (st.turns + 3) % 4), remember(), draw())),
      btn("⟳", "Turn the result a quarter turn clockwise", () => ((st.turns = (st.turns + 1) % 4), remember(), draw())),
      btn("Reset corners", "Put the corners back", () => {
        if (!st.bmp) return;
        st.quad = defaultQuad();
        st.turns = 0;
        remember();
        draw();
      })
    ),
    h("div", { class: "cr-row" },
      btn("Fit", "Fit the photo in the window (F)", fit),
      btn("100%", "Show the photo at 100%", () => {
        const r = stage.getBoundingClientRect();
        if (st.bmp) zoomAt(r.width / 2, r.height / 2, 1 / st.view.s);
      }),
      h("label", { class: "cr-field" }, "Max edge ", maxSel)
    ),
    ...actionBtns,
    h("p", { class: "cr-hint" },
      "Drag the four corners onto the painting's corners (1 top left, 2 top right, 3 bottom right, 4 bottom left). Scroll to zoom, drag the background to move. With a corner selected, the arrow keys nudge it by a pixel (Shift: ten); keys 1–4 select a corner."
    )
  );
  const el = h("div", { class: "cropper" },
    h("div", { class: "cr-bar" }, h("label", { class: "cr-field" }, "Photo ", photo), openBtn, h("span", { class: "cr-spacer" }), statusEl),
    h("div", { class: "cr-layout" }, stage, side)
  );

  function setStatus(text: string, kind = "", link?: { href: string; text: string }) {
    statusEl.className = `cr-status ${kind}`;
    statusEl.textContent = text;
    if (link) statusEl.append(" ", h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text));
  }

  // ---- source picture
  function sourceData(scale: number): ImageData {
    const bmp = st.bmp!;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  }
  const key = () => `atelier-crop.${st.source}`;
  function defaultQuad(): Pt[] {
    const { width: w, height: hh } = st.bmp!;
    const mx = w * 0.1, my = hh * 0.1;
    return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: hh - my }, { x: mx, y: hh - my }];
  }
  function remember() {
    try {
      localStorage.setItem(key(), JSON.stringify({ q: st.quad, t: st.turns }));
    } catch {}
  }
  async function openBlob(blob: Blob, source: string) {
    setStatus("Opening the photo…");
    const bmp = await createImageBitmap(blob);
    st.bmp?.close();
    st.bmp = bmp;
    st.source = source;
    previewSource = undefined;
    st.sel = 0;
    st.turns = 0;
    st.quad = defaultQuad();
    try {
      const saved = JSON.parse(localStorage.getItem(key()) || "null");
      if (saved?.q?.length === 4 && saved.q.every((p: Pt) => p.x <= bmp.width * 1.01 && p.y <= bmp.height * 1.01)) {
        st.quad = saved.q;
        st.turns = saved.t || 0;
      }
    } catch {}
    empty.hidden = true;
    syncButtons();
    layout();
    setStatus(`${bmp.width} × ${bmp.height} px`);
  }

  // ---- stage
  function layout() {
    const r = stage.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (st.bmp && !fitted) fit();
    else draw();
  }
  let fitted = false;
  function fit() {
    const bmp = st.bmp;
    const r = stage.getBoundingClientRect();
    if (!bmp || !r.width) return draw();
    fitted = true;
    const s = Math.min(r.width / bmp.width, r.height / bmp.height) * 0.94;
    st.view = { s, ox: (r.width - bmp.width * s) / 2, oy: (r.height - bmp.height * s) / 2 };
    draw();
  }
  function zoomAt(sx: number, sy: number, factor: number) {
    const v = st.view;
    const s = Math.min(Math.max(v.s * factor, 0.02), 40);
    const k = s / v.s;
    st.view = { s, ox: sx - (sx - v.ox) * k, oy: sy - (sy - v.oy) * k };
    draw();
  }
  const toScreen = (p: Pt): Pt => ({ x: p.x * st.view.s + st.view.ox, y: p.y * st.view.s + st.view.oy });
  const toImage = (x: number, y: number): Pt => ({ x: (x - st.view.ox) / st.view.s, y: (y - st.view.oy) / st.view.s });

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
    const ctx = canvas.getContext("2d")!;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bmp = st.bmp;
    if (!bmp) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = st.view;
    ctx.imageSmoothingEnabled = v.s < 3;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, v.ox, v.oy, bmp.width * v.s, bmp.height * v.s);
    const pts = st.quad.map(toScreen);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fillStyle = "rgb(0 0 0 / 0.38)";
    ctx.fill("evenodd");
    ctx.restore();
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
      const on = i === st.sel || i === hovered;
      ctx.beginPath();
      ctx.arc(p.x, p.y, on ? 10 : 8, 0, Math.PI * 2);
      ctx.fillStyle = i === st.sel ? "#2f5bd3" : "rgb(255 255 255 / 0.9)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = i === st.sel ? "#fff" : "#2f5bd3";
      ctx.stroke();
      ctx.fillStyle = i === st.sel ? "#fff" : "#1f1d1a";
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    });
    if (dragging?.kind === "corner" || hovered >= 0) loupe(ctx, canvas.width / dpr, dragging?.i ?? hovered);
    schedulePreview();
  }

  function loupe(ctx: CanvasRenderingContext2D, stageW: number, i: number) {
    const bmp = st.bmp!;
    const q = st.quad[i];
    const size = 170;
    const x = toScreen(q).x < stageW / 2 ? stageW - size - 12 : 12;
    const y = 12;
    const zoom = Math.max(st.view.s * 4, 2);
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
    ctx.beginPath();
    ctx.moveTo(st.quad[0].x, st.quad[0].y);
    for (const p of st.quad.slice(1)) ctx.lineTo(p.x, p.y);
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

  // ---- result
  let previewQueued = false;
  function schedulePreview() {
    if (previewQueued) return;
    previewQueued = true;
    setTimeout(() => {
      previewQueued = false;
      renderPreview();
    }, 30);
  }
  function outputSize(maxEdge: number) {
    const { w, h: hh } = naturalSize(turned(st.quad, st.turns));
    const k = Math.min(1, maxEdge / Math.max(w, hh, 1));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(hh * k)), k };
  }
  function renderPreview() {
    if (!st.bmp) {
      preview.width = preview.height = 10;
      sizeEl.textContent = "";
      return;
    }
    const full = outputSize(Number(maxSel.value));
    sizeEl.textContent = `Result: ${full.w} × ${full.h} px`;
    const small = outputSize(560);
    if (!previewSource) {
      const scale = Math.min(1, 1600 / Math.max(st.bmp.width, st.bmp.height));
      previewSource = { data: sourceData(scale), scale };
    }
    const { scale, data } = previewSource;
    const quad = turned(st.quad, st.turns).map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const img = warp(data, quad, small.w, small.h);
    preview.width = small.w;
    preview.height = small.h;
    preview.getContext("2d")!.putImageData(img, 0, 0);
  }
  async function renderFull(): Promise<Blob> {
    const { w, h: hh, k } = outputSize(Number(maxSel.value));
    const data = sourceData(k);
    const s = data.width / st.bmp!.width;
    const quad = turned(st.quad, st.turns).map((p) => ({ x: p.x * s, y: p.y * s }));
    const img = warp(data, quad, w, hh);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = hh;
    c.getContext("2d")!.putImageData(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", QUALITY));
    if (!blob || blob.type !== "image/webp") throw new Error("This browser can't save WebP pictures.");
    return blob;
  }

  // ---- input
  const at = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nearest = (x: number, y: number) => {
    let best = -1, bd = 16;
    st.quad.forEach((q, i) => {
      const p = toScreen(q);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (!st.bmp) return;
    const { x, y } = at(e);
    canvas.setPointerCapture(e.pointerId);
    stage.focus({ preventScroll: true });
    const i = nearest(x, y);
    if (i >= 0) {
      st.sel = i;
      dragging = { kind: "corner", i, lx: x, ly: y };
    } else dragging = { kind: "pan", lx: x, ly: y };
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!st.bmp) return;
    const { x, y } = at(e);
    if (!dragging) {
      const i = nearest(x, y);
      if (i !== hovered) {
        hovered = i;
        canvas.style.cursor = i >= 0 ? "crosshair" : "grab";
        draw();
      }
      return;
    }
    if (dragging.kind === "corner") {
      const p = toImage(x, y);
      st.quad[dragging.i!] = { x: Math.min(Math.max(p.x, 0), st.bmp.width), y: Math.min(Math.max(p.y, 0), st.bmp.height) };
    } else {
      st.view.ox += x - dragging.lx;
      st.view.oy += y - dragging.ly;
    }
    dragging.lx = x;
    dragging.ly = y;
    draw();
  });
  const end = () => {
    if (dragging?.kind === "corner") remember();
    dragging = undefined;
    draw();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => {
    if (!dragging && hovered >= 0) {
      hovered = -1;
      draw();
    }
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!st.bmp) return;
      e.preventDefault();
      const { x, y } = at(e);
      zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    },
    { passive: false }
  );
  stage.addEventListener("keydown", (e) => {
    if (!st.bmp) return;
    if (/^[1-4]$/.test(e.key)) {
      st.sel = Number(e.key) - 1;
      return draw();
    }
    if (e.key === "f") return fit();
    const step = e.shiftKey ? 10 : 1;
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const q = st.quad[st.sel];
    st.quad[st.sel] = { x: Math.min(Math.max(q.x + d[0], 0), st.bmp.width), y: Math.min(Math.max(q.y + d[1], 0), st.bmp.height) };
    hovered = st.sel;
    remember();
    draw();
  });
  stage.addEventListener("keyup", () => {
    hovered = -1;
    draw();
  });
  stage.addEventListener("dragover", (e) => {
    e.preventDefault();
    stage.classList.add("drop");
  });
  stage.addEventListener("dragleave", () => stage.classList.remove("drop"));
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    stage.classList.remove("drop");
    openFile(e.dataTransfer?.files[0]);
  });
  async function openFile(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const names = [...photo.options].map((o) => o.value);
      if (!names.includes(file.name)) photo.append(h("option", { value: `file:${file.name}` }, `${file.name} (from computer)`));
      await openBlob(file, file.name);
      photo.value = `file:${file.name}`;
    } catch (err) {
      setStatus(`Couldn't open that file: ${String((err as Error).message ?? err)}`, "error");
    }
  }
  openBtn.addEventListener("click", () => {
    const input = h("input", { type: "file", accept: "image/*" }) as HTMLInputElement;
    input.addEventListener("change", () => openFile(input.files?.[0]));
    input.click();
  });
  async function choose(path: string) {
    if (!path || path.startsWith("file:")) return;
    try {
      setStatus("Loading the photo…");
      await openBlob(await opts.readPhoto(path), path);
    } catch (err) {
      setStatus(`Couldn't open that photo: ${String((err as Error).message ?? err)}`, "error");
    }
  }
  photo.addEventListener("change", () => choose(photo.value));
  maxSel.addEventListener("change", schedulePreview);
  const ro = new ResizeObserver(() => layout());
  ro.observe(stage);

  return {
    el,
    setPhotos(paths, open) {
      photo.replaceChildren(
        h("option", { value: "" }, paths.length ? "Choose a photo…" : "No photos yet"),
        ...paths.map((p) => h("option", { value: p }, p.split("/").pop()!))
      );
      if (open) {
        photo.value = open;
        choose(open);
      }
    },
    openBlob,
    setStatus,
    layout,
    destroy() {
      ro.disconnect();
      st.bmp?.close();
    },
  };
}
