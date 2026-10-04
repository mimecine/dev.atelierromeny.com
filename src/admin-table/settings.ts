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

/** Settings > Pricing in Sveltia (src/content/pricing.yml); these are the defaults
 *  until that file has loaded, or if it's missing. */
export const PRICING_FILE = "src/content/pricing.yml";
export const pricing = { price_per_m2: 2000, rating_step_percent: 20 };

const areaM2 = (d: Record<string, any>) =>
  typeof d.w === "number" && typeof d.h === "number" && d.w > 0 && d.h > 0 ? (d.w * d.h) / 10000 : null;

const toTen = (n: number) => Math.round(n / 10) * 10;
const euros = (n: number) => `€ ${n.toLocaleString("fr-FR")}`;
const basePrice = (d: Record<string, any>) => {
  const a = areaM2(d);
  return a == null ? null : a * pricing.price_per_m2;
};

/** Built when a collection loads, so the labels show the current rate. */
export const computedColumns = (collection: string): ComputedColumn[] =>
  collection !== "works"
    ? []
    : [
        { key: "_area", label: "Area (m²)", after: "h", from: ["w", "h"], value: areaM2, format: (n) => n.toFixed(2) },
        {
          key: "_base_price",
          label: `Base price (€${pricing.price_per_m2}/m²)`,
          after: "_area",
          from: ["w", "h"],
          value: (d) => {
            const b = basePrice(d);
            return b == null ? null : toTen(b);
          },
          format: euros,
        },
        {
          // Rating 3 (or none) = base price; each star either side moves it by the step.
          key: "_price",
          label: `Suggested price (±${pricing.rating_step_percent}%/star)`,
          after: "rating",
          from: ["w", "h", "rating"],
          value: (d) => {
            const b = basePrice(d);
            if (b == null) return null;
            const stars = typeof d.rating === "number" ? d.rating - 3 : 0;
            return toTen(Math.max(0, b * (1 + (stars * pricing.rating_step_percent) / 100)));
          },
          format: euros,
        },
      ];

export const FIELD_OPTIONS: Record<string, Record<string, FieldOptions>> = {
  works: {
    thumbnail: { pickFrom: ["image", "images"] },
    image: { entryImages: true },
    images: { entryImages: true },
    old_image: { entryImages: true },
    hidden_images: { entryImages: true },
  },
};
