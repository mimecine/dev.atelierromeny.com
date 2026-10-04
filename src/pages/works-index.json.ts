export const prerender = true;
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { getImage } from "astro:assets";
import { hasImage, thumbnailOf } from "@src/lib/works";
import { tagSlugsOf } from "@src/lib/tags";

export const GET: APIRoute = async () => {
  const works = (await getCollection("works")).filter(hasImage);

  const items = await Promise.all(
    works.map(async (work) => {
      const optimized = await getImage({
        src: thumbnailOf(work)!,
        width: 600,
      });
      return {
        id: work.id,
        title: work.data.title ?? null,
        year_start: work.data.year_start ?? null,
        tags: tagSlugsOf(work),
        image: optimized.src,
        width: optimized.attributes.width,
        height: optimized.attributes.height,
      };
    }),
  );

  return new Response(JSON.stringify(items), {
    headers: { "Content-Type": "application/json" },
  });
};
