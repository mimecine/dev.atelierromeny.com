import type { CollectionEntry } from "astro:content";

type Work = CollectionEntry<"works">;

/** URL form of a tag: "Mont Ventoux" → "mont-ventoux". */
export const tagSlug = (tag: string) =>
  tag
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents: "trädet" → "tradet"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A work's tags as slugs, without duplicates. */
export const tagSlugsOf = (work: Work) => [...new Set((work.data.tags ?? []).map(tagSlug).filter(Boolean))];

/** Joins tags in a tag page address: /tags/bird+etching/. */
export const TAG_SEPARATOR = "+";

/** Path of a tag page. Slugs are sorted so "a+b" and "b+a" share one page. */
export const tagPath = (slugs: string[]) => `/tags/${[...new Set(slugs)].sort().join(TAG_SEPARATOR)}/`;

/** Every tag in use: its slug, the label to show (most common spelling) and how many works carry it. */
export function tagIndex(works: Work[]) {
  const labels = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  for (const work of works) {
    for (const tag of work.data.tags ?? []) {
      const slug = tagSlug(tag);
      if (!slug) continue;
      const spellings = labels.get(slug) ?? new Map();
      spellings.set(tag, (spellings.get(tag) ?? 0) + 1);
      labels.set(slug, spellings);
    }
    for (const slug of tagSlugsOf(work)) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return [...counts]
    .map(([slug, count]) => ({
      slug,
      count,
      label: [...labels.get(slug)!].sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
