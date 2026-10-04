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
      image: image().optional().nullish(),
      images: z.array(image()).optional().nullish(),
      thumbnail: z.number().int().optional().nullish(), // which image is the thumbnail: 1 = image, 2 = images[0], …
      old_image: image().optional().nullish(), // pre-reshoot photo; shown only when the work has no other image
      description: z.string().optional().nullish(),
      categories: z.string().optional().nullish(),
      w: z.number().optional().nullish(),
      h: z.number().optional().nullish(),
      sheet_w: z.number().optional().nullish(), // prints: paper size; w/h is the image (plate)
      sheet_h: z.number().optional().nullish(),
      location: z.string().optional().nullish(),
      new_location: z.string().optional().nullish(),
      note: z.string().optional().nullish(),
      file: z.string().optional().nullish(),
      year: z.string().optional().nullish(),
      year_start: z.number().optional().nullish(),
      year_end: z.number().optional().nullish(),
      collections: z.array(z.string()).optional().nullish(),
      tags: z.array(z.string()).optional().nullish(),
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

export const collections = {
  works: _works,
  collections: _collections,
  pages: _pages,
};
