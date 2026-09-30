// Marks grid thumbnails with data-loaded once their image has arrived (or failed), which
// ends the pulsing placeholder in global.css. `load` doesn't bubble, so listen in the
// capture phase on document: that also covers pages swapped in by the ClientRouter and
// thumbnails Alpine adds later (the saved page).
const SELECTOR = ".work-thumbnail-container img";

const mark = (e: Event) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.matches(SELECTOR)) img.dataset.loaded = "";
};

// Images that finished (e.g. from cache) before this script ran.
const scan = () => {
  document.querySelectorAll<HTMLImageElement>(SELECTOR).forEach((img) => {
    if (img.complete && img.naturalWidth > 0) img.dataset.loaded = "";
  });
};

document.addEventListener("load", mark, true);
document.addEventListener("error", mark, true);
// after-swap runs before the view transition snapshots the new page, so a thumbnail that
// is already cached is visible in time to be the target of the grid <-> work morph.
document.addEventListener("astro:after-swap", scan);
document.addEventListener("astro:page-load", scan);
scan();
