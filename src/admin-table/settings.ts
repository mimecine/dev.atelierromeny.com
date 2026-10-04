// Table-view-only field settings, kept out of config.yml so Sveltia never sees them.
export interface FieldOptions {
  /** Show as an image chooser over these image fields (in order) and store the chosen
   *  position, 1-based: 1 = the first image. Used for the works' thumbnail number. */
  pickFrom?: string[];
  /** Image pickers show only this entry's images (the ones it references, plus files in
   *  the media folder named after it), and uploads are named after the entry. */
  entryImages?: boolean;
}

export const FIELD_OPTIONS: Record<string, Record<string, FieldOptions>> = {
  works: {
    thumbnail: { pickFrom: ["image", "images"] },
    image: { entryImages: true },
    images: { entryImages: true },
    old_image: { entryImages: true },
  },
};
