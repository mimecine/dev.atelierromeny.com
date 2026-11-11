// Previews built from the site's own pages, shared by Sveltia's preview pane
// (src/cms/previews.ts) and the stand-alone preview tab (src/pages/admin/preview.astro).
//
// Each kind of entry has a template page at /cms-preview/<name> (rendered by Astro with the
// real Layout, so it always has the site's current CSS and markup). The template is
// fetched once; its stylesheets are copied into the preview document and, on every
// update, the page content is rebuilt from the template and filled with the entry.
// Every filled element gets a `data-key-path`, which Sveltia uses for scroll-sync and
// click-to-highlight.
//
// Placeholder attributes (field names are relative to the entry, or to the list item
// inside a data-list <template>; names starting with "_" are worked out here, see derive()):
//   data-field="title"         text content
//   data-field-html="body"     markdown
//   data-field-src="image"     <img> src
//   data-list="_strip" + <template>   repeated per list item (plain strings are { value })
//   data-if="field"            hidden when the field is empty
//   data-placeholder="…"       shown (muted) when the field is empty
import { marked } from "marked";
import { HIDE_DETAILS } from "@src/lib/works";

export type Data = Record<string, any>;
export type Template = { styles: string[]; htmlClass: string; bodyClass: string; body: string };

/** Which template page each Sveltia collection uses. */
export const TEMPLATE_FOR: Record<string, string> = {
  works: "work",
  pages: "page",
  photos: "photo",
  collections: "collection",
};

const templates = new Map<string, Promise<Template>>();
export function loadTemplate(name: string): Promise<Template> {
  if (!templates.has(name)) {
    templates.set(
      name,
      fetch(`/cms-preview/${name}/`)
        .then((res) => res.text())
        .then((text) => {
          const doc = new DOMParser().parseFromString(text, "text/html");
          // Stylesheets and inline styles (dev serves CSS as <style> tags), with URLs
          // made absolute so they resolve inside an iframe.
          const styles = [...doc.head.querySelectorAll('link[rel="stylesheet"], style')].map((el) => {
            if (el instanceof HTMLLinkElement) el.href = new URL(el.getAttribute("href")!, location.origin).href;
            return el.outerHTML;
          });
          doc.body.querySelectorAll("script").forEach((s) => s.remove());
          const header = doc.body.querySelector(".site-header");
          const main = doc.body.querySelector("main");
          return {
            styles,
            htmlClass: doc.documentElement.className,
            bodyClass: doc.body.className,
            body: (header?.outerHTML ?? "") + (main?.outerHTML ?? doc.body.innerHTML),
          };
        })
    );
  }
  return templates.get(name)!;
}

/** Copies the template's stylesheets and page classes into the document that shows the preview. */
export function prepareDocument(doc: Document, tpl: Template) {
  if (!doc.head.querySelector("[data-cms-preview-styles]")) {
    const marker = doc.createElement("meta");
    marker.setAttribute("data-cms-preview-styles", "");
    doc.head.append(marker);
    doc.head.insertAdjacentHTML("beforeend", tpl.styles.join("\n"));
    // Muted look for empty fields, so editors can see where content will go.
    doc.head.insertAdjacentHTML(
      "beforeend",
      `<style>.cms-empty{opacity:.35;font-style:italic}[data-key-path]{cursor:pointer}</style>`
    );
  }
  doc.documentElement.className = tpl.htmlClass;
  doc.body.className = tpl.bodyClass;
}

const get = (data: Data, path: string) => path.split(".").reduce((v: any, k) => v?.[k], data);
const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
const DETAIL = /-detail(\.[\w-]+)?\.webp(\?.*)?$/;

/** Adds the values the site works out from an entry's fields (the main image, the thumbnail
 *  strip, the info line), following src/lib/works.ts. */
export function derive(collection: string, data: Data): Data {
  if (collection !== "works") return data;
  const all = strings(data.images);
  const hidden = new Set(strings(data.hidden_images));
  let strip = all.filter((p) => !hidden.has(p) && !(HIDE_DETAILS && DETAIL.test(p)));
  if (!strip.length && data.old_image && (!all.length || (HIDE_DETAILS && all.every((p) => DETAIL.test(p))))) {
    strip = [String(data.old_image)];
  }
  const n = Number(data.thumbnail);
  const chosen = n >= 1 ? all[n - 1] : undefined;
  const main = chosen && strip.includes(chosen) ? chosen : strip[0];
  const year = data.year_start ? `, ${data.year_start}${data.year_end ? `–${data.year_end}` : ""}` : "";
  const size = data.w && data.h ? ` (${data.w} × ${data.h} cm)` : "";
  return {
    ...data,
    _main: main,
    _missing: main ? undefined : "1",
    _strip: strip.length > 1 ? strip : [],
    _info: `${data.title || "No title recorded"}${year}${size}`,
  };
}

function setEmpty(el: Element, empty: boolean) {
  el.classList.toggle("cms-empty", empty);
  const placeholder = el.getAttribute("data-placeholder");
  if (empty && placeholder) el.textContent = placeholder;
}

/** Fills the placeholders under `root` with `data`. `prefix` is the key path of `data` within
 *  the entry ("" for the entry itself, "images.3." for a list item). Fields are filled before
 *  lists are expanded, since elements inside an unexpanded <template> aren't matched. */
export function fill(root: Element, data: Data, prefix: string, assetUrl: (path: string) => string) {
  const all = (sel: string) => [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)];
  const mark = (el: Element, name: string) => {
    if (!name.startsWith("_") && !prefix.startsWith("_")) el.setAttribute("data-key-path", prefix + name);
  };

  for (const el of all("[data-if]")) {
    if (isEmpty(get(data, el.getAttribute("data-if")!))) (el as HTMLElement).style.display = "none";
  }
  for (const el of all("[data-field]")) {
    const name = el.getAttribute("data-field")!;
    const value = get(data, name);
    mark(el, name);
    el.textContent = isEmpty(value) ? "" : String(value);
    setEmpty(el, isEmpty(value));
  }
  for (const el of all("[data-field-src]")) {
    const name = el.getAttribute("data-field-src")!;
    const value = get(data, name);
    mark(el, name);
    const url = isEmpty(value) ? "" : assetUrl(String(value));
    if (url) {
      el.setAttribute("src", url);
      el.removeAttribute("srcset");
      (el as HTMLElement).style.display = "";
    } else (el as HTMLElement).style.display = "none";
  }
  for (const el of all("[data-field-html]")) {
    const name = el.getAttribute("data-field-html")!;
    const value = get(data, name);
    mark(el, name);
    if (isEmpty(value)) setEmpty(el, true);
    else el.innerHTML = marked.parse(String(value), { async: false }) as string;
  }
  for (const el of all("[data-list]")) {
    const name = el.getAttribute("data-list")!;
    const template = el.querySelector(":scope > template") as HTMLTemplateElement | null;
    if (!template) continue;
    const items = get(data, name);
    mark(el, name);
    (Array.isArray(items) ? items : []).forEach((item, i) => {
      const fragment = template.content.cloneNode(true) as DocumentFragment;
      for (const child of [...fragment.children]) {
        if (!name.startsWith("_") && !prefix.startsWith("_")) child.setAttribute("data-key-path", `${prefix}${name}.${i}`);
        fill(child, typeof item === "object" && item ? item : { value: item }, `${prefix}${name}.${i}.`, assetUrl);
      }
      el.append(fragment);
    });
    template.remove();
  }
}

/** Replaces `container`'s content with the template filled with the entry. */
export function render(container: HTMLElement, tpl: Template, collection: string, data: Data, assetUrl: (path: string) => string) {
  container.innerHTML = tpl.body;
  fill(container, derive(collection, data), "", assetUrl);
}
