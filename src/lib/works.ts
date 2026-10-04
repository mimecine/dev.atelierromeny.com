import type { CollectionEntry } from "astro:content";

type Work = CollectionEntry<"works">;

/** The images a work shows, in order: `image`, then `images`. A work with neither
 *  falls back to its old (pre-reshoot) photo. */
export function imagesOf(work: Work) {
  const current = [work.data.image, ...(work.data.images ?? [])].filter((img) => !!img);
  return current.length ? current : [work.data.old_image].filter((img) => !!img);
}

/** Whether the work has any picture to show (it's left out of grids otherwise). */
export const hasImage = (work: Work) => imagesOf(work).length > 0;

/** Position (0-based) of the image used for grids, search and link previews, which is
 *  also the one the work page opens on: `thumbnail` picks it (1 = Image, 2 = the first
 *  of More Images, …), otherwise the first image. */
export function thumbnailIndex(work: Work) {
  const n = work.data.thumbnail;
  return n && n >= 1 && n <= imagesOf(work).length ? n - 1 : 0;
}

export const thumbnailOf = (work: Work) => imagesOf(work)[thumbnailIndex(work)];

/** Shown wherever a work has no title. (A title actually recorded as "Untitled" is kept.) */
export const NO_TITLE = "No title recorded";
export const titleOf = (work: Work) => work.data.title || NO_TITLE;

/** By title, works without a title last. */
export const byTitle = (a: Work, b: Work) =>
  (a.data.title ? 0 : 1) - (b.data.title ? 0 : 1) || (a.data.title ?? "").localeCompare(b.data.title ?? "");
