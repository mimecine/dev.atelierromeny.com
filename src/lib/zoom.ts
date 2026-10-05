// Fullscreen zoom/pan viewer for any <img data-zoom-src="…">. The <img> fills the whole
// stage (the picture is letterboxed inside it by object-contain): Panzoom's zoom-to-point
// assumes the element starts at the stage's corner, and a centred, narrower <img> made
// the zoom drift sideways. Listeners are delegated
// from `document`, so this survives ClientRouter page swaps without re-initialising.
import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";

let pz: PanzoomObject | null = null;
let swallowKeyup = false;
let initialised = false;

const BUTTON = "size-10 grid place-items-center rounded-full bg-white/15 text-white text-xl hover:bg-white/30 cursor-pointer";

/** Whether a click hit the picture rather than the empty bands object-contain leaves. */
function onPicture(img: HTMLImageElement, e: MouseEvent) {
  const r = img.getBoundingClientRect();
  if (!img.naturalWidth || !img.naturalHeight) return true;
  const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  const x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
  return e.clientX >= x && e.clientX <= x + w && e.clientY >= y && e.clientY <= y + h;
}

function viewer() {
  let dialog = document.getElementById("zoom-viewer") as HTMLDialogElement | null;
  if (dialog) return dialog;

  dialog = document.createElement("dialog");
  dialog.id = "zoom-viewer";
  dialog.className =
    "m-0 p-0 w-screen h-dvh max-w-none max-h-none bg-black/95 backdrop:bg-black/95 overflow-hidden";
  dialog.innerHTML = `
    <div data-stage class="relative w-full h-full overflow-hidden touch-none">
      <img alt="" draggable="false" class="absolute inset-0 w-full h-full object-contain select-none cursor-grab" />
    </div>
    <div class="absolute top-3 right-3 flex gap-2">
      <button type="button" data-zoom="in" aria-label="Zoom in" class="${BUTTON}">+</button>
      <button type="button" data-zoom="out" aria-label="Zoom out" class="${BUTTON}">&minus;</button>
      <button type="button" data-zoom="reset" aria-label="Fit to screen" class="${BUTTON}">&#x2922;</button>
      <button type="button" data-zoom="close" aria-label="Close" class="${BUTTON}">&times;</button>
    </div>
    <p class="absolute bottom-3 inset-x-0 text-center text-white/50 text-sm pointer-events-none">
      Pinch or scroll to zoom &middot; drag to pan &middot; double-tap to zoom in/out
    </p>`;
  document.body.append(dialog);

  const stage = dialog.querySelector<HTMLElement>("[data-stage]")!;
  const img = stage.querySelector("img")!;

  dialog.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom]")?.dataset.zoom;
    if (action === "in") pz?.zoomIn();
    else if (action === "out") pz?.zoomOut();
    else if (action === "reset") pz?.reset();
    else if (action === "close") dialog!.close();
    // A click on the dark area around an unzoomed picture closes too (the letterbox
    // bands are part of the <img> now, so check where the picture itself is drawn)
    else if ((pz?.getScale() ?? 1) <= 1.01 && (e.target === stage || (e.target === img && !onPicture(img, e)))) dialog!.close();
  });
  stage.addEventListener("wheel", (e) => pz?.zoomWithWheel(e));
  img.addEventListener("dblclick", (e) => {
    if (!pz) return;
    if (pz.getScale() > 1.01) pz.reset();
    else pz.zoomToPoint(3, e);
  });
  dialog.addEventListener("close", () => {
    pz?.destroy();
    pz = null;
    img.removeAttribute("src");
    document.documentElement.style.overflow = "";
  });
  return dialog;
}

function open(source: HTMLImageElement) {
  const dialog = viewer();
  const img = dialog.querySelector<HTMLImageElement>("[data-stage] img")!;
  // Show the already-loaded picture straight away, then swap in the large one.
  img.src = source.currentSrc || source.src;
  img.alt = source.alt;
  const large = new Image();
  large.onload = () => {
    if (dialog.open) img.src = large.src;
  };
  large.src = source.dataset.zoomSrc!;

  pz = Panzoom(img, { maxScale: 8, minScale: 1, panOnlyWhenZoomed: true, step: 0.5 });
  document.documentElement.style.overflow = "hidden";
  dialog.showModal();
}

export function initZoom() {
  if (initialised) return;
  initialised = true;

  document.addEventListener("click", (e) => {
    const source = (e.target as HTMLElement).closest<HTMLImageElement>("img[data-zoom-src]");
    if (source) open(source);
  });

  // The work pages bind Esc / ←/→ on keyup to navigate away. While the viewer is open
  // (or its Esc just closed it) those keys belong to the viewer.
  window.addEventListener(
    "keydown",
    (e) => {
      const dialog = document.getElementById("zoom-viewer") as HTMLDialogElement | null;
      if (!dialog?.open) return;
      if (e.key === "Escape") swallowKeyup = true;
      else if (e.key === "+" || e.key === "=") pz?.zoomIn();
      else if (e.key === "-") pz?.zoomOut();
      else if (e.key === "0") pz?.reset();
    },
    true
  );
  window.addEventListener(
    "keyup",
    (e) => {
      const dialog = document.getElementById("zoom-viewer") as HTMLDialogElement | null;
      if (dialog?.open || swallowKeyup) e.stopImmediatePropagation();
      swallowKeyup = false;
    },
    true
  );
  document.addEventListener("astro:before-swap", () => {
    (document.getElementById("zoom-viewer") as HTMLDialogElement | null)?.close();
  });
}
