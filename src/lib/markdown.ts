import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri";
import { getImage } from "astro:assets";
import { resolveMedia } from "./media";
import satteriImageCaptions from "./satteri-image-captions.js";

// For markdown stored outside content collections (front page sections). Built once per
// build. Local images are swapped for optimised versions before rendering.
let processor: ReturnType<typeof createSatteriMarkdownProcessor> | undefined;

const IMAGE = /!\[([^\]]*)\]\(\s*(\S+?)(\s+"[^"]*")?\s*\)/g;

export async function renderMarkdown(markdown?: string | null): Promise<string> {
  if (!markdown) return "";
  processor ??= createSatteriMarkdownProcessor({ hastPlugins: [satteriImageCaptions as any] });
  const replacements = await Promise.all(
    [...markdown.matchAll(IMAGE)].map(async ([whole, alt, url, title = ""]) => {
      const meta = resolveMedia(url);
      if (!meta) return [whole, whole];
      const img = await getImage({ src: meta, width: Math.min(meta.width, 1600) });
      return [whole, `![${alt}](${img.src}${title})`];
    })
  );
  const source = replacements.reduce((md, [from, to]) => md.replace(from, to), markdown);
  return (await (await processor).render(source)).code;
}
