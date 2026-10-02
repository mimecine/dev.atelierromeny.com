// Uploads are converted like Sveltia does (see media_libraries in config.yml): WebP,
// quality 90, at most 3000px on the long side. Browsers that can't encode WebP keep
// the original file.
const MAX_EDGE = 3000;
const QUALITY = 0.9;

export async function prepareUpload(file: File): Promise<{ blob: Blob; ext: string }> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml" || file.type === "image/gif") {
    return { blob: file, ext: file.name.split(".").pop()?.toLowerCase() || "bin" };
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", QUALITY));
    if (blob && blob.type === "image/webp") return { blob, ext: "webp" };
  } catch {
    // fall through to the original file
  }
  return { blob: file, ext: file.name.split(".").pop()?.toLowerCase() || "jpg" };
}

/** "Photo 12 (final).JPG" -> "photo-12-final" (Sveltia's slugify_filename style) */
export function slugifyBase(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "image"
  );
}
