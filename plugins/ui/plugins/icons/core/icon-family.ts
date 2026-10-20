import type { CustomRef } from "./icon-ref";
import type { SpriteKey } from "./style";
import type { SymbolName } from "./symbol-names.generated";

/**
 * An icon family's id: what a theme scope's `iconFamily` token names. The
 * built-in base is {@link MATERIAL_FAMILY}; every other family is contributed
 * (`Icons.Family`, icons web), so the set is open and an id is a spelling, not
 * a closed union.
 */
export type IconFamilyId = string;

/** The built-in family every chain ends at: the Material Symbols drawing, in the scope's style. */
export const MATERIAL_FAMILY: IconFamilyId = "material";

const FAMILY_ID_RE = /^[a-z][a-z0-9-]*$/;

export function isIconFamilyId(value: string): value is IconFamilyId {
  return FAMILY_ID_RE.test(value);
}

/**
 * One glyph of an app-drawn family: the inner markup of a 24-unit box. A
 * `stroke` glyph (the default) is an outline painted in `currentColor` at the
 * family's stroke width with round caps and joins; a `fill` glyph is filled in
 * `currentColor`. The paint is the sheet's (one `<g>` around the body), so a
 * body carries geometry only — an element may still override a paint
 * attribute (a thicker stroke for a piano's black keys).
 */
export interface IconGlyph {
  readonly body: string;
  readonly paint?: "stroke" | "fill";
}

/**
 * A family an app draws itself: its glyphs ship as data in the plugin's web
 * bundle (tens of glyphs — nothing to tree-shake), rendered into the page's
 * sprite sheet by the icons plugin once the family is contributed.
 *
 * - `symbols` restyles Material names: in a scope whose `iconFamily` is this
 *   family, `symbol(name)` draws the mapped glyph — shared chrome included.
 *   A name it does not map falls to `fallback` (another family's id), and the
 *   chain ends at Material.
 * - `icon(glyph)` names a glyph Material has no name for: a {@link CustomRef},
 *   drawn from this family in EVERY scope (one style, like a brand).
 */
export interface InlineIconFamily<G extends string = string> {
  readonly kind: "inline";
  readonly id: IconFamilyId;
  readonly label: string;
  readonly fallback?: IconFamilyId;
  /** The stroke width, in the 24-unit box, every `stroke` glyph is drawn at. */
  readonly stroke: number;
  readonly glyphs: Readonly<Record<G, IconGlyph>>;
  readonly symbols: Readonly<Partial<Record<SymbolName, G>>>;
  icon(name: G): CustomRef;
}

/**
 * A family drawn from a server-built sprite, fetched the first time an icon in
 * one of its scopes mounts (Lucide: thousands of glyphs, so the server ships
 * only the manifest's). Until the sprite lands, a mapped symbol draws the next
 * family of the chain.
 */
export interface SpriteIconFamily {
  readonly kind: "sprite";
  readonly id: IconFamilyId;
  readonly label: string;
  readonly fallback?: IconFamilyId;
  readonly sprite: SpriteKey;
  /** The sprite `<symbol>` id drawing `name`, or `undefined` when the family does not draw it. */
  idOf(name: SymbolName): string | undefined;
}

/** A contributed icon family (`Icons.Family`). */
export type IconFamily = InlineIconFamily | SpriteIconFamily;

/** The elements a glyph body may hold; anything else throws at definition. */
const SHAPES = new Set([
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);

const TAG_RE = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g;

function checkBody(family: string, glyph: string, body: string): void {
  for (const [, name, attrs] of body.matchAll(TAG_RE)) {
    if (!SHAPES.has(name!)) {
      throw new Error(
        `[icons] family "${family}" glyph "${glyph}": <${name}> is not a shape element`,
      );
    }
    if (/\son[a-z]+\s*=|href\s*=/i.test(attrs!)) {
      throw new Error(
        `[icons] family "${family}" glyph "${glyph}": event handlers and references are not allowed`,
      );
    }
  }
}

/**
 * Define an app-drawn icon family (from the plugin's `core/`, so any runtime
 * can name its glyphs). The glyph names are the `glyphs` keys, so
 * `family.icon("…")` and every `symbols` value are checked by tsc. A body
 * holding anything but shape elements throws: the sheet injects it as markup.
 */
export function defineIconFamily<G extends string>(def: {
  id: IconFamilyId;
  label: string;
  fallback?: IconFamilyId;
  stroke: number;
  glyphs: Record<G, IconGlyph>;
  symbols: Partial<Record<SymbolName, NoInfer<G>>>;
}): InlineIconFamily<G> {
  if (!isIconFamilyId(def.id) || def.id === MATERIAL_FAMILY) {
    throw new Error(`[icons] "${def.id}" is not a valid icon family id`);
  }
  for (const [name, glyph] of Object.entries<IconGlyph>(def.glyphs)) {
    checkBody(def.id, name, glyph.body);
  }
  return {
    kind: "inline",
    ...def,
    icon: (name) => ({ kind: "custom", family: def.id, name }),
  };
}

/** The sheet `<symbol>` id of an app-drawn family's glyph. */
export function familyGlyphId(family: IconFamilyId, glyph: string): string {
  return `fam-${family}-${glyph}`;
}

/** The `<symbol>` markup of every glyph of an inline family, for the sheet. */
export function familyGlyphMarkup(family: InlineIconFamily): string {
  const symbols = Object.entries<IconGlyph>(family.glyphs).map(
    ([name, glyph]) => {
      const paint =
        glyph.paint === "fill"
          ? 'fill="currentColor" stroke="none"'
          : `fill="none" stroke="currentColor" stroke-width="${family.stroke}" stroke-linecap="round" stroke-linejoin="round"`;
      return `<symbol id="${familyGlyphId(family.id, name)}" viewBox="0 0 24 24"><g ${paint}>${glyph.body}</g></symbol>`;
    },
  );
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>`;
}
