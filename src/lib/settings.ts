import { parse } from "yaml";
import { readFileSync } from "fs";

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

export function loadSettings(yaml_file: string): Settings {
  const settingsFile = yaml_file;
  const fileContent = readFileSync(settingsFile, "utf8");
  const settings: Settings = parse(fileContent);
  return settings;
}
