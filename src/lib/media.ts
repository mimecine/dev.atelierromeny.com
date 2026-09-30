import type { ImageMetadata } from "astro";

// Every image under src/media, so paths stored as plain strings (settings.yml, markdown
// written by Sveltia) can be turned into optimisable images like content-collection ones.
const files = import.meta.glob<{ default: ImageMetadata }>(
  "/src/media/**/*.{webp,jpg,jpeg,png,gif,avif}",
  { eager: true }
);

/** "/src/media/…" or "@src/media/…" -> ImageMetadata (undefined if unknown).
 *  The old "@img/x" form (before src/media/img became src/media/works) still works. */
export function resolveMedia(ref?: string | null): ImageMetadata | undefined {
  if (!ref) return undefined;
  const path = ref.startsWith("@img/")
    ? `/src/media/works/${ref.slice(5)}`
    : ref.startsWith("@src/")
      ? `/src/${ref.slice(5)}`
      : ref;
  return files[path]?.default;
}
