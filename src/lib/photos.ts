import { getCollection, type CollectionEntry } from "astro:content";

export type Photo = CollectionEntry<"photos">;

/** `count` photos picked at random (each build picks anew), for mixing into grids. */
export async function randomPhotos(count: number): Promise<Photo[]> {
  const photos = await getCollection("photos", (p) => p.data.published !== false);
  for (let i = photos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [photos[i], photos[j]] = [photos[j], photos[i]];
  }
  return photos.slice(0, count);
}

/** Published photos, newest first (undated ones after, by title). */
export async function publishedPhotos(): Promise<Photo[]> {
  const photos = await getCollection("photos", (p) => p.data.published !== false);
  return photos.sort(
    (a, b) =>
      (b.data.date?.getTime() ?? -Infinity) - (a.data.date?.getTime() ?? -Infinity) ||
      a.data.title.localeCompare(b.data.title)
  );
}
