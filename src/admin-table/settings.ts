// Table-view-only field settings, kept out of config.yml so Sveltia never sees them.
export interface FieldOptions {
  /** Show as an image chooser over these image fields (in order) and store the chosen
   *  position, 1-based: 1 = the first image. Used for the works' thumbnail number. */
  pickFrom?: string[];
  /** Image pickers show only this entry's images (the ones it references, plus files in
   *  the media folder named after it), and uploads are named after the entry. */
  entryImages?: boolean;
  /** Image lists: the hover preview gets "Hidden" and "Thumbnail" checkboxes, kept in
   *  these fields (a list of hidden paths, and the 1-based position of the thumbnail). */
  hideIn?: string;
  thumbnailIn?: string;
  /** …and a "Cleanest" checkbox: the path of the photo the measuring/cropping scripts
   *  should use (it may well be hidden on the site). */
  cleanestIn?: string;
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

/** Settings > Parameters > Pricing in Sveltia (the `pricing` group in this file); these
 *  are the defaults until it has loaded, or if it's missing. */
export const PRICING_FILE = "src/content/settings/parameters.yml";
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

/** Starting column order and hidden columns, until you drag or hide columns yourself
 *  (that layout is remembered per browser). Columns not listed follow, in config order. */
export const COLUMN_DEFAULTS: Record<string, { order: string[]; hidden: string[]; hideOnce?: string[] }> = {
  works: {
    order: [
      "title", "images", "thumbnail",
      "w", "h", "_area", "_base_price", "rating", "_price",
      "year", "edition", "collections", "categories", "sheet_w", "sheet_h",
    ],
    hidden: [
      "hidden_images", "old_image", "year_start", "year_end", "tags", "published",
      "body", "location", "new_location", "note", "id",
      // set from the image preview's Thumbnail checkbox now; the field itself stays
      "thumbnail",
      "cleanest",
    ],
    // Columns newly hidden by default: also hidden once in layouts people already
    // saved (they can show them again from Columns).
    hideOnce: ["thumbnail", "cleanest"],
  },
};

export const FIELD_OPTIONS: Record<string, Record<string, FieldOptions>> = {
  works: {
    thumbnail: { pickFrom: ["images"] },
    images: { entryImages: true, hideIn: "hidden_images", thumbnailIn: "thumbnail", cleanestIn: "cleanest" },
    old_image: { entryImages: true },
    hidden_images: { entryImages: true },
  },
};

/** Toolbar filters (dropdowns with counts) per collection. Without an entry here, every
 *  tag-like, select and relation column gets one. */
export const FACETS: Record<string, string[]> = {
  works: ["tags", "categories", "collections"],
};
