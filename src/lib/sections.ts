import type { CollectionEntry } from "astro:content";
import { byTitle } from "./works";

type Work = CollectionEntry<"works">;

/** Works in a collection's hand-made order (its `order` list of slugs); works not in the list
 *  follow, by title. */
export function sortManually(works: Work[], order?: string[] | null): Work[] {
  const at = new Map((order ?? []).map((slug, i) => [slug, i]));
  const pos = (w: Work) => at.get(w.id) ?? Infinity;
  return [...works].sort((a, b) => (pos(a) === pos(b) ? byTitle(a, b) : pos(a) - pos(b)));
}

/** Order for the front page's work grids: "title" (default), "newest", "oldest", or "manual"
 *  (the collection's own order, when given). */
export function sortWorks(works: Work[], sort?: string, order?: string[] | null): Work[] {
  if (sort === "manual") return sortManually(works, order);
  const year = (w: Work) => Number(w.data.year_start) || 0;
  if (sort === "newest") return [...works].sort((a, b) => year(b) - year(a) || byTitle(a, b));
  if (sort === "oldest") return [...works].sort((a, b) => (year(a) || 9999) - (year(b) || 9999) || byTitle(a, b));
  return [...works].sort(byTitle);
}
