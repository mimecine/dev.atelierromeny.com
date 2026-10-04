import type { CollectionEntry } from "astro:content";
import { byTitle } from "./works";

type Work = CollectionEntry<"works">;

/** Order for the front page's work grids: "title" (default), "newest" or "oldest". */
export function sortWorks(works: Work[], sort?: string): Work[] {
  const year = (w: Work) => Number(w.data.year_start) || 0;
  if (sort === "newest") return [...works].sort((a, b) => year(b) - year(a) || byTitle(a, b));
  if (sort === "oldest") return [...works].sort((a, b) => (year(a) || 9999) - (year(b) || 9999) || byTitle(a, b));
  return [...works].sort(byTitle);
}
