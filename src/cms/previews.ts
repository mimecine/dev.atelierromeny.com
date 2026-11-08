// Sveltia CMS preview panes built from the site's own pages (see preview-render.ts):
// one template per collection, registered before the CMS starts (src/pages/admin/index.astro).
import { React, registerPreviewTemplate } from "@sveltia/cms";
import { TEMPLATE_FOR, loadTemplate, prepareDocument, render, type Template } from "./preview-render";

const h = React.createElement;

function makePreview(collection: string) {
  const name = TEMPLATE_FOR[collection];
  return function Preview(props: any) {
    const { entry, getAsset, document: doc } = props;
    const ref = React.useRef<HTMLDivElement>(null);
    const [template, setTemplate] = React.useState<Template | null>(null);

    React.useEffect(() => {
      loadTemplate(name).then(setTemplate);
    }, []);

    React.useEffect(() => {
      const container = ref.current;
      if (!template || !container) return;
      prepareDocument(doc ?? container.ownerDocument, template);
      const data = entry.get("data")?.toJS?.() ?? {};
      const assetUrl = (path: string) => {
        if (/^(https?:|blob:|data:)/.test(path)) return path;
        const asset = getAsset(path);
        return asset?.url ?? (asset ? String(asset) : "");
      };
      render(container, template, collection, data, assetUrl);
    });

    return h("div", { ref, className: "cms-preview" });
  };
}

export function registerPreviews() {
  for (const collection of Object.keys(TEMPLATE_FOR)) registerPreviewTemplate(collection, makePreview(collection) as any);
}
