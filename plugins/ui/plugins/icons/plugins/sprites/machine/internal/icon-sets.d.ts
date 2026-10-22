// Types for `icon-sets.js` — see there for why it is JS.
export interface IconSetSource {
  /** The package name, e.g. `@iconify-json/material-symbols`. */
  readonly name: string;
  readonly version: string;
  /** Path of the embedded `icons.json` — readable with `Bun.file`. */
  readonly file: string;
}

export declare const ICON_SETS: {
  readonly regular: IconSetSource;
  readonly light: IconSetSource;
  readonly brands: IconSetSource;
  readonly lucide: IconSetSource;
};
