/**
 * The SVG elements a drawing references by `url(#id)` rather than renders:
 * masks, clip paths, paint servers, filters, markers. Under a `display: none`
 * ancestor such a resource is not rendered, so every reference to it draws
 * nothing (a mask then hides nothing, a gradient paints nothing).
 */
const RESOURCE =
  /<(mask|clipPath|linearGradient|radialGradient|pattern|filter|marker)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g;

/** A sheet's markup split by what the style engine must see. */
export interface SplitSheetMarkup {
  /** The whole `<svg>` with its resources taken out: only ever `<use>`d, so it may sit under `display: none`. */
  readonly symbols: string;
  /** An `<svg>` of the resources taken out, ids unchanged, or `null` when there are none: must sit in a rendered subtree. */
  readonly resources: string | null;
}

/**
 * Split a sheet's `<svg>` of `<symbol>`s (a sprite, a chunk of saved symbols, a
 * family's glyphs) into its symbols and the resources they reference. A
 * `<use href="#id">` of a symbol under `display: none` still draws — the
 * browser clones the symbol into the `<use>`'s own tree — but a resource is
 * resolved in the document, so it must stay rendered. Neither generated sheet
 * nests a resource in one of its own kind, which the lazy match relies on.
 */
export function splitSheetMarkup(markup: string): SplitSheetMarkup {
  const resources: string[] = [];
  const symbols = markup.replace(RESOURCE, (resource) => {
    resources.push(resource);
    return "";
  });
  return {
    symbols,
    resources:
      resources.length === 0
        ? null
        : `<svg xmlns="http://www.w3.org/2000/svg">${resources.join("")}</svg>`,
  };
}
