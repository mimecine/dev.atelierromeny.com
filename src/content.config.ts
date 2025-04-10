import { defineCollection, z } from "astro:content";
import { glob, file } from "astro/loaders";

const _works = defineCollection({
  loader: glob({ pattern: ["**/*.md", "!_*"], base: "./src/content/works" }),
  schema: ({ image }) =>
    z.object({
      uuid: z.string().optional().nullish(),
      title: z.string().optional().nullish(),
      image: image().optional().nullish(),
      categories: z.string().optional().nullish(),
      w: z.number().optional().nullish(),
      h: z.number().optional().nullish(),
      location: z.string().optional().nullish(),
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
      id: z.string().optional().nullish(),
      title: z.string().optional().nullish(),
      image: image().optional().nullish(),
      published: z.boolean().optional().nullish(),
      inmenu: z.boolean().optional().nullish(),
    }),
});

export const collections = {
  works: _works,
  collections: _collections,
};
