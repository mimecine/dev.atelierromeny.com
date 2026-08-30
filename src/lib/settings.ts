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
}

export interface Link {
  title: string;
  href: string;
}

export interface Section {
  type: string;
  title: string;
  hidden?: boolean;
  collection?: string;
  show_title?: boolean;
  images?: string[];
}

export function loadSettings(): Settings {
  return parse(settingsRaw);
}
