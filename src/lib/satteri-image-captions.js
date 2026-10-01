// An image on its own line with a title — ![alt](src "Title") — gets the title as a
// small caption underneath: <p class="md-figure"><img …><span class="md-caption">Title</span></p>
// (styled in global.css). The <img> itself is left alone so Astro still optimises it.
import { defineHastPlugin } from "satteri";

export default defineHastPlugin({
  name: "satteri-image-captions",
  element: {
    filter: ["p"],
    visit(node, ctx) {
      const children = node.children.filter((c) => !(c.type === "text" && !c.value.trim()));
      const [img] = children;
      if (children.length !== 1 || img.type !== "element" || img.tagName !== "img") return;
      const title = String(img.properties?.title ?? "").trim();
      if (!title) return;
      ctx.setProperty(node, "className", ["md-figure"]);
      ctx.appendChild(node, {
        type: "element",
        tagName: "span",
        properties: { className: ["md-caption"] },
        children: [{ type: "text", value: title }],
      });
    },
  },
});
