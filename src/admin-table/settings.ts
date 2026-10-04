// Table-view-only field settings, kept out of config.yml so Sveltia never sees them.
export interface FieldOptions {
  /** Show as an image chooser over these image fields (in order) and store the chosen
   *  position, 1-based: 1 = the first image. Used for the works' thumbnail number. */
  pickFrom?: string[];
  /** Image pickers show only this entry's images (the ones it references, plus files in
   *  the media folder named after it), and uploads are named after the entry. */
  entryImages?: boolean;
}

/** A read-only column worked out from other fields; never saved to the files. */
export interface ComputedColumn {
  key: string;
  label: string;
  /** shown right after this field */
  after: string;
  /** the fields it's worked out from; editing one updates the column */
  from: string[];
  value: (data: Record<string, any>) => number | null;
  format: (n: number) => string;
}

/** Euros per square metre of the work (w × h) for the suggested price. */
export const PRICE_PER_M2 = 2000;

const areaM2 = (d: Record<string, any>) =>
  typeof d.w === "number" && typeof d.h === "number" && d.w > 0 && d.h > 0 ? (d.w * d.h) / 10000 : null;

export const COMPUTED_COLUMNS: Record<string, ComputedColumn[]> = {
  works: [
    { key: "_area", label: "Area (m²)", after: "h", from: ["w", "h"], value: areaM2, format: (n) => n.toFixed(2) },
    {
      key: "_price",
      label: `Suggested price (€${PRICE_PER_M2}/m²)`,
      after: "_area",
      from: ["w", "h"],
      value: (d) => {
        const a = areaM2(d);
        return a == null ? null : Math.round((a * PRICE_PER_M2) / 10) * 10;
      },
      format: (n) => `€ ${n.toLocaleString("fr-FR")}`,
    },
  ],
};

export const FIELD_OPTIONS: Record<string, Record<string, FieldOptions>> = {
  works: {
    thumbnail: { pickFrom: ["image", "images"] },
    image: { entryImages: true },
    images: { entryImages: true },
    old_image: { entryImages: true },
  },
};
