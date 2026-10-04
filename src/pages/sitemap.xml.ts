export const prerender = true;
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { isMenuCollection } from "@src/lib/settings";
import { hasImage } from "@src/lib/works";

// Lists exactly the pages open to search engines (the same rule as the noindex tags):
// home, published markdown pages, collections linked from Settings > Navigation, and the
// canonical /works/<slug>/ page of each work shown under them. Submit https://atelierromeny.com/sitemap.xml in Google Search Console.
export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL("https://atelierromeny.com");
  const paths = ["/"];

  const pages = await getCollection("pages", (p) => p.data.published);
  paths.push(...pages.map((p) => `/${p.id}/`));

  const collections = await getCollection(
    "collections",
    (c) => c.data.published !== false && isMenuCollection(c.id)
  );
  const works = await getCollection("works", hasImage);
  const ids = new Set(collections.map((c) => c.id));
  for (const collection of collections) paths.push(`/${collection.id}/`);
  for (const work of works) {
    if (work.data.collections?.some((c) => ids.has(c))) paths.push(`/works/${work.id}/`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${new URL(p, base).href}</loc></url>`).join("\n")}
</urlset>
`;
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
};
