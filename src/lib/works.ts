import type { CollectionEntry } from "astro:content";

/** All of a work's images in order: `image`, then `images`. */
export const imagesOf = (work: CollectionEntry<"works">) =>
  [work.data.image, ...(work.data.images ?? [])].filter((img) => !!img);

/** The image used for grids and search results: `thumbnail` picks one by position
 *  (1 = main image, 2 = first extra image, …), falling back to the main image. */
export function thumbnailOf(work: CollectionEntry<"works">) {
  const all = imagesOf(work);
  const n = work.data.thumbnail;
  return all[n && n >= 1 && n <= all.length ? n - 1 : 0];
}
