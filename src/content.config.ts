import { defineCollection, z } from "astro:content";
import { glob, file } from "astro/loaders";

const _works = defineCollection({
  loader: glob({ pattern: ["**/*.md", "!_*"], base: "./src/content/works" }),
  schema: ({ image }) =>
    z.object({
      uuid: z.string().optional().nullish(),
      // Older CMS saves wrote the id as a string ('127')
      id: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).optional().nullish(),
      title: z.string().optional().nullish(),
      // the main photo first; the detail (…-detail.webp: the artwork alone, cut out and
      // straightened by scripts/make-details) last
      images: z.array(image()).optional().nullish(),
      hidden_images: z.array(image()).optional().nullish(), // kept in the files, not shown on the site
      thumbnail: z.number().int().optional().nullish(), // which of `images` is the thumbnail, 1-based
      cleanest: z.string().optional().nullish(), // path of the photo scripts measure and crop from (may be hidden)
      old_image: image().optional().nullish(), // pre-reshoot photo; shown only when the work has no other image
      description: z.string().optional().nullish(),
      categories: z.string().optional().nullish(),
      w: z.number().optional().nullish(),
      h: z.number().optional().nullish(),
      rating: z.number().int().min(1).max(5).optional().nullish(), // 1–5, admin only
      sheet_w: z.number().optional().nullish(), // prints: paper size; w/h is the image (plate)
      sheet_h: z.number().optional().nullish(),
      location: z.string().optional().nullish(),
      new_location: z.string().optional().nullish(),
      note: z.string().optional().nullish(),
      file: z.string().optional().nullish(),
      year: z.string().optional().nullish(),
      edition: z.string().optional().nullish(), // prints: as pencilled, e.g. "4/20", "e.a."
      year_start: z.number().optional().nullish(),
      year_end: z.number().optional().nullish(),
      collections: z.array(z.string()).optional().nullish(),
      tags: z.array(z.string()).optional().nullish(),
      published: z.boolean().optional().nullish(), // false = left off the site (missing = shown)
    }),
});

const _collections = defineCollection({
  loader: glob({
    pattern: ["**/*.md", "!_*"],
    base: "./src/content/collections",
  }),
  schema: ({ image }) =>
    z.object({
      uuid: z.string().optional().nullish(),
      title: z.string().optional().nullish(),
      image: image().optional().nullish(),
      published: z.boolean().optional().nullish(),
      inmenu: z.boolean().optional().nullish(),
    }),
});

const _pages = defineCollection({
  loader: glob({
    pattern: ["**/*.md", "!_*"],
    base: "./src/content/pages",
  }),
  schema: ({ image }) =>
    z.object({
      layout: z.string().default("../../layouts/Layout.astro"),
      title: z.string(),
      image: image().optional().nullish(),
      tags: z.array(z.string()).optional().nullish(),
      published: z.boolean(),
      note: z.string().optional().nullish(),
      css: z.string().optional().nullish(),
      js: z.string().optional().nullish(),
    }),
});

// Photos with a caption and description (/photos/). Media in src/media/photos.
const _photos = defineCollection({
  loader: glob({ pattern: ["**/*.md", "!_*"], base: "./src/content/photos" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      image: image(),
      caption: z.string().optional().nullish(),
      date: z.coerce.date().optional().nullish(),
      published: z.boolean().default(true),
    }),
});

export const collections = {
  works: _works,
  collections: _collections,
  pages: _pages,
  photos: _photos,
};
