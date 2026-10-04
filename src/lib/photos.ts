import { getCollection, type CollectionEntry } from "astro:content";

export type Photo = CollectionEntry<"photos">;

/** Published photos, newest first (undated ones after, by title). */
export async function publishedPhotos(): Promise<Photo[]> {
  const photos = await getCollection("photos", (p) => p.data.published !== false);
  return photos.sort(
    (a, b) =>
      (b.data.date?.getTime() ?? -Infinity) - (a.data.date?.getTime() ?? -Infinity) ||
      a.data.title.localeCompare(b.data.title)
  );
}
