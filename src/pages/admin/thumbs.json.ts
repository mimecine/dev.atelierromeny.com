export const prerender = true;
import type { APIRoute } from "astro";
import type { ImageMetadata } from "astro";
import { getImage } from "astro:assets";

// Small thumbnails of every image under src/media, keyed by the path content uses
// ("/src/media/works/x.webp"), for the admin table view (/admin/table/). Images added
// after the last build are fetched from GitHub by the table view instead.
const files = import.meta.glob<{ default: ImageMetadata }>("/src/media/**/*.{webp,jpg,jpeg,png,gif,avif}", {
  eager: true,
});

export const GET: APIRoute = async () => {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, mod]) => {
      const img = await getImage({ src: mod.default, width: Math.min(mod.default.width, 240), format: "webp" });
      return [path, img.src] as const;
    })
  );
  return new Response(JSON.stringify(Object.fromEntries(entries)), {
    headers: { "Content-Type": "application/json" },
  });
};
