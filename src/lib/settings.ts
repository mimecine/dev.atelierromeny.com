import { parse } from "yaml";
// Imported as a module (not read via `fs` at request time) so it's part of
// Astro's module dependency graph — required for the Cloudflare Workers
// runtime (no source-tree filesystem access at runtime) and so that
// experimental.incrementalBuild's dependency-graph hash picks up edits here.
// Settings are split over four files, one per entry under Settings in the CMS.
import homeRaw from "../content/settings/home.yml?raw";
import navigationRaw from "../content/settings/navigation.yml?raw";
import footerRaw from "../content/settings/footer.yml?raw";
import parametersRaw from "../content/settings/parameters.yml?raw";

export interface Settings {
  site_title: string;
  menu: Link[];
  sections: Section[];
  socials: Link[];
  copyright: string;
  ga: string;
  css: string;
  js: string;
  description: string;
  author: string;
  email: string;
  /** default image for link previews */
  share_image?: string;
  barrier?: Barrier;
  /** mix a photo into collection grids after every this many works (0 = off) */
  photos_every?: number;
}

/** Settings > Parameters > Password */
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
/** One front page section; which fields apply depends on `type` (see public/admin/config.yml). */
export interface Section {
  type:
    | "collection"
    | "tag"
    | "works"
    | "featured"
    | "carousel"
    | "image"
    | "textimage"
    | "content"
    | "quote"
    | "cta"
    | "divider"
    | string;
  title?: string;
  hidden?: boolean;
  show_title?: boolean;
  // work grids (collection, tag, works)
  collection?: string;
  tag?: string;
  works?: string[];
  columns?: number | string;
  /** number of works shown (0 = all) */
  limit?: number;
  /** older collection sections: rows instead of a number of works */
  max_rows?: number;
  sort?: "title" | "newest" | "oldest" | string;
  more_label?: string;
  // featured work
  work?: string;
  // carousel
  images?: string[];
  visible?: number | string;
  height?: number;
  autoplay?: boolean;
  interval?: number;
  // image, text & image
  image?: string;
  image_side?: "left" | "right" | string;
  caption?: string;
  href?: string;
  // content, text & image, call to action
  header?: string;
  text?: string;
  // quote
  quote?: string;
  attribution?: string;
  // call to action
  button_label?: string;
  button_href?: string;
  // divider
  style?: "line" | "space" | string;
  size?: "small" | "medium" | "large" | string;
}

/** All settings in one object, whichever file they live in. */
export function loadSettings(): Settings {
  const home = parse(homeRaw) ?? {};
  const navigation = parse(navigationRaw) ?? {};
  const footer = parse(footerRaw) ?? {};
  const parameters = parse(parametersRaw) ?? {};
  return {
    ...home,
    ...navigation,
    ...footer,
    ...(parameters.seo ?? {}),
    ...(parameters.advanced ?? {}),
    barrier: parameters.password,
    photos_every: Number(parameters.photos?.every ?? 0) || 0,
  };
}

/** A collection is "in the menu" if a link in Settings > Navigation points to it. Only those
 *  collections, and works shown under them, are open to search engines.
 *  (The collections' own "Shown In Menu" flag isn't used; the menu comes from Settings.) */
export function isMenuCollection(id: string) {
  const hrefs = (loadSettings().menu ?? []).map((m) => m.href.replace(/\/+$/, ""));
  return hrefs.includes(`/${id}`);
}
