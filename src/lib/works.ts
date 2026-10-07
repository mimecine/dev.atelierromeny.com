import type { CollectionEntry } from "astro:content";

type Work = CollectionEntry<"works">;

/** `images`, hidden ones included: the list `thumbnail` counts in. */
const allImagesOf = (work: Work) => (work.data.images ?? []).filter((img) => !!img);

/** The images a work shows, in order (the main photo first, the detail last), minus any listed under
 *  `hidden_images` (kept in the files, just not shown). A work without images falls back to
 *  its old (pre-reshoot) photo; one whose images are all hidden shows none. */
export function imagesOf(work: Work) {
  const all = allImagesOf(work);
  if (!all.length) return [work.data.old_image].filter((img) => !!img);
  const hidden = new Set((work.data.hidden_images ?? []).map((img) => img.src));
  return all.filter((img) => !hidden.has(img!.src));
}

/** Whether the work has any picture to show (it's left out of grids otherwise). */
export const hasImage = (work: Work) => imagesOf(work).length > 0;

/** Position (0-based) of the image used for grids, search and link previews, which is
 *  also the one the work page opens on: `thumbnail` picks it (1 = the first of `images`),
 *  otherwise the first image. */
export function thumbnailIndex(work: Work) {
  const n = work.data.thumbnail;
  const chosen = n && n >= 1 ? allImagesOf(work)[n - 1] : undefined;
  const i = chosen ? imagesOf(work).indexOf(chosen) : -1;
  return i >= 0 ? i : 0; // the chosen one is hidden or missing: the first shown image
}

export const thumbnailOf = (work: Work) => imagesOf(work)[thumbnailIndex(work)];

/** Shown wherever a work has no title. (A title actually recorded as "Untitled" is kept.) */
export const NO_TITLE = "No title recorded";
export const titleOf = (work: Work) => work.data.title || NO_TITLE;

/** By title, works without a title last. */
export const byTitle = (a: Work, b: Work) =>
  (a.data.title ? 0 : 1) - (b.data.title ? 0 : 1) || (a.data.title ?? "").localeCompare(b.data.title ?? "");
