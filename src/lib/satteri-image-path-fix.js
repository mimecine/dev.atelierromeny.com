// Sveltia writes images inside markdown bodies as "/src/media/…", which Astro would
// treat as a public URL. Rewriting to the "@src/…" alias makes Astro resolve and
// optimise them like any other local image. (Same fix as in the ar-new project.)
import { defineMdastPlugin } from "satteri";

export default defineMdastPlugin({
  name: "satteri-image-path-fix",
  image(node, ctx) {
    if (node.url && node.url.startsWith("/src/")) {
      ctx.setProperty(node, "url", node.url.replace("/src/", "@src/"));
    }
  },
});
