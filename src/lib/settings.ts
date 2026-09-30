import { parse } from "yaml";
// Imported as a module (not read via `fs` at request time) so it's part of
// Astro's module dependency graph — required for the Cloudflare Workers
// runtime (no source-tree filesystem access at runtime) and so that
// experimental.incrementalBuild's dependency-graph hash picks up edits here.
import settingsRaw from "../content/settings.yml?raw";

export interface Settings {
  site_title: string;
  menu: Link[];
  sections: Section[];
  socials: Link[];
  copyright: string;
  ga: string;
  css: string;
  js: string;
  collections: string[];
  description: string;
  author: string;
  email: string;
  /** default image for link previews */
  share_image?: string;
  barrier?: Barrier;
}

/** Settings > Password Protection */
export interface Barrier {
  enabled?: boolean;
  password?: string;
  days?: number;
  /** markdown shown under the password field */
  text?: string;
}

export interface Link {
  title: string;
  href: string;
}

/** One front page section; which fields apply depends on `type` (see public/admin/config.yml). */
export interface Section {
  type: "collection" | "carousel" | "image" | "content" | string;
  title?: string;
  hidden?: boolean;
  show_title?: boolean;
  // collection
  collection?: string;
  columns?: number | string;
  max_rows?: number;
  // carousel
  images?: string[];
  visible?: number | string;
  height?: number;
  autoplay?: boolean;
  interval?: number;
  // image
  image?: string;
  caption?: string;
  href?: string;
  // content
  header?: string;
  text?: string;
}

export function loadSettings(): Settings {
  return parse(settingsRaw);
}

/** A collection is "in the menu" if a link in Settings > Menu points to it. Only those
 *  collections, and works shown under them, are open to search engines.
 *  (The collections' own "Shown In Menu" flag isn't used; the menu comes from Settings.) */
export function isMenuCollection(id: string) {
  const hrefs = (loadSettings().menu ?? []).map((m) => m.href.replace(/\/+$/, ""));
  return hrefs.includes(`/${id}`);
}
