// Warms the work page's large image when a card is hovered, focused or touched, so it is
// (usually) already in the cache when the page opens: less blink as it loads.
// Cards carry the URL in data-preload-src (see WorkCard.astro).
const seen = new Set<string>();

function warm(e: Event) {
  const link = (e.target as Element | null)?.closest?.<HTMLElement>("a[data-preload-src]");
  const src = link?.dataset.preloadSrc;
  if (!src || seen.has(src)) return;
  seen.add(src);
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  img.decode?.().catch(() => {});
}

for (const type of ["pointerover", "focusin", "touchstart"]) {
  document.addEventListener(type, warm, { passive: true });
}
