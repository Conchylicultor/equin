/**
 * The SVG elements a drawing references by `url(#id)` rather than renders:
 * masks, clip paths, paint servers, filters, markers. Under a `display: none`
 * ancestor such a resource is not rendered, so every reference to it draws
 * nothing (a mask then hides nothing, a gradient paints nothing).
 */
const RESOURCE =
  /<(mask|clipPath|linearGradient|radialGradient|pattern|filter|marker)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g;

/** One `<symbol>` (symbols never nest): its attributes and its body. */
const SYMBOL = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g;
const ID = /\bid="([^"]*)"/;

/** A sheet's markup split by what the style engine must see. */
export interface SplitSheetMarkup {
  /** The whole `<svg>` with its resources taken out: only ever `<use>`d, so it may sit under `display: none`. */
  readonly symbols: string;
  /**
   * Each symbol's resources, by symbol id, ids unchanged — only symbols that
   * have any: they must sit in a rendered subtree while the symbol is drawn.
   */
  readonly resources: ReadonlyMap<string, string>;
}

/**
 * Split a sheet's `<svg>` of `<symbol>`s (a sprite, a chunk of saved symbols, a
 * family's glyphs) into its symbols and, per symbol, the resources it
 * references. A `<use href="#id">` of a symbol under `display: none` still
 * draws — the browser clones the symbol into the `<use>`'s own tree — but a
 * resource is resolved in the document, so it must stay rendered. A resource
 * belongs to the symbol it is written in (an active form's masks are); one
 * outside every symbol has no owner to render it for, and throws. Neither
 * generated sheet nests a resource in one of its own kind, which the lazy
 * match relies on.
 */
export function splitSheetMarkup(markup: string): SplitSheetMarkup {
  const resources = new Map<string, string>();
  const symbols = markup.replace(
    SYMBOL,
    (whole, attrs: string, body: string) => {
      const owned: string[] = [];
      const rest = body.replace(RESOURCE, (resource) => {
        owned.push(resource);
        return "";
      });
      if (owned.length === 0) return whole;
      const id = ID.exec(attrs)?.[1];
      if (id === undefined) {
        throw new Error(`[icons] a sheet symbol with resources has no id`);
      }
      resources.set(id, owned.join(""));
      return `<symbol${attrs}>${rest}</symbol>`;
    },
  );
  const stray = symbols.replace(SYMBOL, "").match(RESOURCE);
  if (stray !== null) {
    throw new Error(
      `[icons] a sheet resource outside every symbol: ${stray[0].slice(0, 80)}`,
    );
  }
  return { symbols, resources };
}
