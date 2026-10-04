export const prerender = true;
import type { APIRoute } from "astro";
import type { ImageMetadata } from "astro";
import { getImage } from "astro:assets";

// A thumbnail (240px) and a hover preview (720px) of every image under src/media,
// keyed by the path content uses ("/src/media/works/x.webp"), for the admin table view
// (/admin/table/). Images added
// after the last build are fetched from GitHub by the table view instead.
const files = import.meta.glob<{ default: ImageMetadata }>("/src/media/**/*.{webp,jpg,jpeg,png,gif,avif}", {
  eager: true,
});

export const GET: APIRoute = async () => {
  // The dev server doesn't resize images (every "thumbnail" would be the full-size
  // original), so in dev the table view makes its own small thumbnails instead.
  if (import.meta.env.DEV) return new Response("{}", { headers: { "Content-Type": "application/json" } });
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, mod]) => {
      const [small, large] = await Promise.all([
        getImage({ src: mod.default, width: Math.min(mod.default.width, 240), format: "webp" }),
        getImage({ src: mod.default, width: Math.min(mod.default.width, 720), format: "webp" }),
      ]);
      return [path, [small.src, large.src]] as const;
    })
  );
  return new Response(JSON.stringify(Object.fromEntries(entries)), {
    headers: { "Content-Type": "application/json" },
  });
};
