// The preview tab: shows the entry the table view is editing, in the site's own template
// (see ../cms/preview-render.ts). The table view posts { type: "entry", collection, slug,
// data, assets } on a BroadcastChannel whenever the previewed entry changes; this page asks
// for the current state on load with { type: "hello" }. Assets are URLs the table view made
// (the build's image URLs, or data: URLs for images not built yet).
import { TEMPLATE_FOR, loadTemplate, prepareDocument, render } from "../cms/preview-render";

window.name = "preview";
const channel = new BroadcastChannel("atelier-preview");
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

let last: { collection: string; slug: string; data: Record<string, any>; assets: Record<string, string> } | undefined;

async function show() {
  if (!last) return;
  const name = TEMPLATE_FOR[last.collection];
  const note = $("#note");
  if (!name) {
    note.textContent = `No preview for ${last.collection} yet.`;
    return;
  }
  const tpl = await loadTemplate(name);
  prepareDocument(document, tpl);
  const { assets } = last;
  const assetUrl = (path: string) => assets[path] ?? (/^(https?:|blob:|data:)/.test(path) ? path : "");
  const scroll = scrollY;
  render($("#preview"), tpl, last.collection, last.data, assetUrl);
  scrollTo(0, scroll);
  note.textContent = `Previewing ${last.data.title || last.slug} (${last.collection}), including unsaved edits`;
  document.title = `Preview: ${last.data.title || last.slug}`;
}

channel.addEventListener("message", (e) => {
  if (e.data?.type !== "entry") return;
  last = e.data;
  show();
});

channel.postMessage({ type: "hello" });
setTimeout(() => {
  if (!last) {
    $("#note").innerHTML = 'Nothing to show yet. Open this from the table view (the 👁 on a row), which keeps it up to date as you edit.';
  }
}, 1500);
