// Fields (from the Sveltia config) and entries (markdown files with YAML frontmatter).
// Edits only touch the keys that changed, through the YAML document, so the rest of
// each file keeps its formatting and comments.
import { parseDocument, type Document } from "yaml";
import type { ComputedColumn, FieldOptions } from "./settings";

export interface FieldConfig {
  name: string;
  label?: string;
  widget?: string;
  required?: boolean;
  multiple?: boolean;
  collection?: string;
  value_field?: string;
  display_fields?: string[];
  options?: (string | number | { label: string; value: string | number })[];
  field?: FieldConfig;
  fields?: FieldConfig[];
  value_type?: string;
  media_folder?: string;
  public_folder?: string;
  hint?: string;
  default?: unknown;
}

export interface CollectionConfig {
  name: string;
  label?: string;
  label_singular?: string;
  folder?: string;
  media_folder?: string;
  public_folder?: string;
  fields: FieldConfig[];
}

export type Kind =
  | "text"
  | "longtext"
  | "number"
  | "boolean"
  | "select"
  | "relation"
  | "image"
  | "images"
  | "strings"
  | "markdown"
  | "imagechoice"
  | "computed"
  | "unsupported";

export interface Column {
  field: FieldConfig;
  kind: Kind;
  key: string;
  label: string;
  options: FieldOptions;
  /** set on read-only columns worked out from other fields (kind "computed") */
  computed?: ComputedColumn;
}

export function kindOf(f: FieldConfig): Kind | null {
  switch (f.widget ?? "string") {
    case "hidden":
      return null;
    case "string":
      return "text";
    case "text":
      return "longtext";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "select":
      return "select";
    case "relation":
      return "relation";
    case "image":
    case "file":
      return "image";
    case "markdown":
      return "markdown";
    case "list": {
      if (f.field?.widget === "image" || f.field?.widget === "file") return "images";
      const sub = f.field ?? (f.fields?.length === 1 ? f.fields[0] : undefined);
      if (!f.field && !f.fields) return "strings";
      if (sub && (sub.widget ?? "string") === "string") return "strings";
      return "unsupported";
    }
    default:
      return "unsupported";
  }
}

export function columnsOf(collection: CollectionConfig, options: Record<string, FieldOptions> = {}): Column[] {
  return collection.fields.flatMap((field) => {
    const opts = options[field.name] ?? {};
    const kind = opts.pickFrom ? "imagechoice" : kindOf(field);
    return kind ? [{ field, kind, key: field.name, label: field.label ?? field.name, options: opts }] : [];
  });
}

export interface Entry {
  /** file name, e.g. "127-la-serviette-bleue.md" */
  name: string;
  slug: string;
  path: string;
  original: string;
  doc: Document;
  body: string;
  data: Record<string, any>;
  dirty: Set<string>;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function parseEntry(name: string, path: string, text: string): Entry {
  const m = text.match(FRONTMATTER);
  const doc = parseDocument(m ? m[1] : "");
  const data = (doc.toJS() as Record<string, any>) ?? {};
  const body = m ? m[2] : text;
  return { name, slug: name.replace(/\.[^.]+$/, ""), path, original: text, doc, body, data: { ...data, body }, dirty: new Set() };
}

const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** The file's new text with the dirty keys applied. */
export function serializeEntry(entry: Entry): string {
  for (const key of entry.dirty) {
    if (key === "body") continue;
    const value = entry.data[key];
    if (isEmpty(value)) {
      if (entry.doc.has(key)) entry.doc.delete(key);
    } else {
      entry.doc.set(key, entry.doc.createNode(value));
    }
  }
  const yaml = entry.doc.toString({ lineWidth: 0 }).trimEnd();
  const body = entry.dirty.has("body") ? entry.data.body ?? "" : entry.body;
  return `---\n${yaml}\n---\n${body}`;
}

/** List-of-strings fields stored either as strings or as one-key objects ({ tag: "x" }). */
export function readStrings(col: Column, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const key = col.field.fields?.length === 1 ? col.field.fields[0].name : undefined;
  return value
    .map((v) => (key && v && typeof v === "object" ? v[key] : v))
    .filter((v) => v != null && v !== "")
    .map(String);
}

export function writeStrings(col: Column, values: string[]): unknown[] {
  const key = col.field.fields?.length === 1 ? col.field.fields[0].name : undefined;
  return key ? values.map((v) => ({ [key]: v })) : values;
}

/** "{{slug}}" / "{{fields.title}}" / "title" style templates from the Sveltia config. */
export function templateValue(entry: Entry, template: string | undefined): string {
  const t = template ?? "{{slug}}";
  if (!t.includes("{{")) return String(entry.data[t] ?? "");
  return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k: string) => {
    if (k === "slug") return entry.slug;
    const name = k.replace(/^fields\./, "");
    return String(entry.data[name] ?? "");
  });
}
