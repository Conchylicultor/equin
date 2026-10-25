import type { CustomRef } from "./icon-ref";
import { isIconMotion } from "./icon-motion";
import { deriveActiveForm, placeActiveIds } from "./active-form";
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
 * One glyph of an app-drawn family, as its author writes it: the inner markup
 * of a 24-unit box. A `stroke` glyph (the default) is an outline painted in
 * `currentColor` at the family's stroke width with round caps and joins; a
 * `fill` glyph is filled in `currentColor`. The paint is the sheet's (one
 * `<g>` around the body), so a body carries geometry only — an element may
 * still override a paint attribute (a thicker stroke for a piano's black keys).
 *
 * A part that moves carries `data-motion="<kind>"` (`ICON_MOTIONS`), and may add
 * `data-motion-delay="<ms>"` and `data-motion-origin="<x> <y>"` (grid units).
 *
 * `active` is the glyph's ACTIVE form — what `<Icon active>` draws (a pinned
 * pin, an on star) in a scope whose `iconActiveFill` is `filled`. Optional: by
 * default it is DERIVED from `body` (`deriveActiveForm`: the outer closed
 * shapes filled, what lies inside them cut out). Write one where the derived
 * form misses the point — a shape left open, like a pin's head. Same paint and
 * rules as `body`; a part is filled by its own `fill="currentColor"`.
 */
export interface IconGlyphSource {
  readonly body: string;
  readonly active?: string;
  readonly paint?: "stroke" | "fill";
}

/**
 * A defined glyph: its source, with `body` the DRAWN body (each moving part's
 * delay and origin written as its inline style, `pathLength="1"` on a `draw`
 * part); `active` its drawn active form — the source's, else the derived one,
 * its mask ids written with `ACTIVE_ID_TOKEN` (absent when there is nothing to
 * fill: the glyph draws the same active); and `animated` — derived, true when
 * either form holds a moving part. An
 * animated glyph is drawn inline by `<Icon>` (a `<use>` shadow tree is out of
 * the page CSS's reach), every other one through `<use>`.
 */
export interface IconGlyph extends IconGlyphSource {
  readonly animated: boolean;
}

/**
 * How much a family promises to draw itself, in a scope whose `iconFamily` is
 * this family:
 *
 * - `fallback` — a symbol it does not map draws from `fallback` (another
 *   family's id), and the chain ends at Material.
 * - `strict` — it draws every symbol itself: one it does not map draws the
 *   family's GAP glyph (a dashed rounded square), never another family's
 *   drawing, and is reported once per (family, name). No fallback to name.
 *
 * Required, so every family states it.
 */
export type IconFamilyCoverage =
  | { readonly coverage: "fallback"; readonly fallback?: IconFamilyId }
  | { readonly coverage: "strict"; readonly fallback?: never };

/**
 * A family an app draws itself: its glyphs ship as data in the plugin's web
 * bundle (tens of glyphs — nothing to tree-shake), rendered into the page's
 * sprite sheet by the icons plugin once the family is contributed.
 *
 * - `symbols` restyles Material names: in a scope whose `iconFamily` is this
 *   family, `symbol(name)` draws the mapped glyph — shared chrome included.
 *   A name it does not map goes by its {@link IconFamilyCoverage}.
 * - `icon(glyph)` names a glyph Material has no name for: a {@link CustomRef},
 *   drawn from this family in EVERY scope (one style, like a brand).
 */
export type InlineIconFamily<G extends string = string> = {
  readonly kind: "inline";
  readonly id: IconFamilyId;
  readonly label: string;
  /** The stroke width, in the 24-unit box, every `stroke` glyph is drawn at. */
  readonly stroke: number;
  readonly glyphs: Readonly<Record<G, IconGlyph>>;
  readonly symbols: Readonly<Partial<Record<SymbolName, G>>>;
  icon(name: G): CustomRef;
} & IconFamilyCoverage;

/**
 * A family drawn from a server-built sprite, fetched the first time an icon in
 * one of its scopes mounts (Lucide: thousands of glyphs, so the server ships
 * only the manifest's). Until the sprite lands, a mapped symbol draws the next
 * family of the chain. Always `fallback` coverage: a strict family's gap glyph
 * lives in an inline family's sheet.
 */
export interface SpriteIconFamily {
  readonly kind: "sprite";
  readonly id: IconFamilyId;
  readonly label: string;
  readonly coverage: "fallback";
  readonly fallback?: IconFamilyId;
  readonly sprite: SpriteKey;
  /**
   * The sprite holding the family's active drawings (fetched on first use, like
   * `sprite`); without one, an active icon draws as at rest.
   */
  readonly activeSprite?: SpriteKey;
  /**
   * The sprite `<symbol>` id drawing `name` — its active drawing, in
   * `activeSprite`, when `active` — or `undefined` when the family does not
   * draw it.
   */
  idOf(name: SymbolName, active: boolean): string | undefined;
}

/** A contributed icon family (`Icons.Family`). */
export type IconFamily = InlineIconFamily | SpriteIconFamily;

/**
 * What `family` draws `name` with, or `undefined` when it does not map it: an
 * inline family's glyph name, a sprite family's `<symbol>` id. The ONE mapping
 * predicate the fallback chain walks (icons web `resolveIconDrawing` /
 * `resolveIconSource`).
 */
export function familyGlyphOf(
  family: IconFamily,
  name: SymbolName,
): string | undefined {
  return family.kind === "inline"
    ? family.symbols[name]
    : family.idOf(name, false);
}

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

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
const ATTR_RE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DELAY_RE = /^\d+$/;
const ORIGIN_RE = /^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/;

function attributesOf(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, dq, sq] of attrs.matchAll(ATTR_RE)) {
    out.set(name!, dq ?? sq ?? "");
  }
  return out;
}

/**
 * Check one glyph body and return its DRAWN body: shape elements only, no
 * event handler or reference, every `data-motion*` attribute valid — and each
 * moving part's delay / origin written as its inline style (`--icon-motion-delay`,
 * a view-box `transform-origin`), `pathLength="1"` added to a `draw` part.
 * Throws on anything else: the sheet and `<Icon>` inject the body as markup.
 */
function drawnBody(
  family: string,
  glyph: string,
  body: string,
): { body: string; animated: boolean } {
  const fail = (why: string): never => {
    throw new Error(`[icons] family "${family}" glyph "${glyph}": ${why}`);
  };
  let animated = false;
  const drawn = body.replace(
    TAG_RE,
    (whole, close: string, name: string, attrs: string) => {
      if (!SHAPES.has(name)) fail(`<${name}> is not a shape element`);
      if (/\son[a-z]+\s*=|href\s*=/i.test(attrs)) {
        fail("event handlers and references are not allowed");
      }
      if (close === "/") return whole;
      const a = attributesOf(attrs);
      const motion = a.get("data-motion");
      for (const key of a.keys()) {
        if (
          key.startsWith("data-motion") &&
          key !== "data-motion" &&
          key !== "data-motion-delay" &&
          key !== "data-motion-origin"
        ) {
          fail(`unknown motion attribute ${key}`);
        }
      }
      const delay = a.get("data-motion-delay");
      const origin = a.get("data-motion-origin");
      if (motion === undefined) {
        if (delay !== undefined || origin !== undefined) {
          fail(`<${name}> has a motion delay or origin but no data-motion`);
        }
        return whole;
      }
      if (!isIconMotion(motion)) fail(`unknown motion "${motion}"`);
      animated = true;
      if (delay !== undefined && !DELAY_RE.test(delay)) {
        fail(`data-motion-delay="${delay}" is not a whole number of ms`);
      }
      if (origin !== undefined && !ORIGIN_RE.test(origin)) {
        fail(`data-motion-origin="${origin}" is not "<x> <y>" in grid units`);
      }
      const extra: string[] = [];
      const style: string[] = [];
      if (delay !== undefined) style.push(`--icon-motion-delay:${delay}ms`);
      if (origin !== undefined) {
        const [x, y] = origin.split(" ");
        style.push(`transform-box:view-box`, `transform-origin:${x}px ${y}px`);
      }
      if (style.length > 0) {
        if (a.has("style")) {
          fail(`<${name}> sets a style beside a motion delay or origin`);
        }
        extra.push(`style="${style.join(";")}"`);
      }
      if (motion === "draw") {
        if (name === "g") fail("a draw part is a shape, not a <g>");
        const length = a.get("pathLength");
        if (length === undefined) extra.push(`pathLength="1"`);
        else if (length !== "1") fail(`a draw part needs pathLength="1"`);
      }
      if (extra.length === 0) return whole;
      const selfClosing = attrs.trimEnd().endsWith("/");
      const head = selfClosing ? attrs.trimEnd().slice(0, -1) : attrs;
      return `<${name}${head} ${extra.join(" ")}${selfClosing ? "/" : ""}>`;
    },
  );
  return { body: drawn, animated };
}

/**
 * Define an app-drawn icon family (from the plugin's `core/`, so any runtime
 * can name its glyphs). The glyph names are the `glyphs` keys, so
 * `family.icon("…")` and every `symbols` value are checked by tsc. A body
 * holding anything but shape elements, or an invalid motion, throws: the sheet
 * injects it as markup.
 */
export function defineIconFamily<G extends string>(
  def: {
    id: IconFamilyId;
    label: string;
    stroke: number;
    glyphs: Record<G, IconGlyphSource>;
    symbols: Partial<Record<SymbolName, NoInfer<G>>>;
  } & IconFamilyCoverage,
): InlineIconFamily<G> {
  if (!isIconFamilyId(def.id) || def.id === MATERIAL_FAMILY) {
    throw new Error(`[icons] "${def.id}" is not a valid icon family id`);
  }
  const glyphs = {} as Record<G, IconGlyph>;
  for (const name of Object.keys(def.glyphs) as G[]) {
    const source = def.glyphs[name];
    const rest = drawnBody(def.id, name, source.body);
    const active =
      source.active !== undefined
        ? drawnBody(def.id, `${name} (active)`, source.active)
        : source.paint === "fill"
          ? undefined
          : (() => {
              const derived = deriveActiveForm(rest.body);
              return derived === undefined
                ? undefined
                : { body: derived, animated: rest.animated };
            })();
    glyphs[name] = {
      ...source,
      body: rest.body,
      ...(active === undefined ? {} : { active: active.body }),
      animated: rest.animated || active?.animated === true,
    };
  }
  return {
    kind: "inline",
    ...def,
    glyphs,
    icon: (name) => ({ kind: "custom", family: def.id, name }),
  };
}

/**
 * The sheet `<symbol>` id of an app-drawn family's glyph — of its active form
 * when `active` (its own prefix, so no glyph name can collide with it). Only a
 * glyph that has an active form has an active id.
 */
export function familyGlyphId(
  family: IconFamilyId,
  glyph: string,
  active = false,
): string {
  return `${active ? "famact" : "fam"}-${family}-${glyph}`;
}

/**
 * The sheet `<symbol>` id of a strict family's gap glyph: what a symbol the
 * family does not map draws in its scopes. Its own prefix, so no glyph name
 * can collide with it.
 */
export function familyGapId(family: IconFamilyId): string {
  return `famgap-${family}`;
}

/** The gap glyph: a dashed rounded square, drawn in the family's stroke. */
const GAP_BODY =
  '<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="2 2.5"/>';

function strokePaint(family: InlineIconFamily): string {
  return `fill="none" stroke="currentColor" stroke-width="${family.stroke}" stroke-linecap="round" stroke-linejoin="round"`;
}

/**
 * One glyph as drawn: its body inside the one `<g>` carrying the family's
 * paint. The `<symbol>` content of the sheet, and what `<Icon>` draws inline
 * for an animated glyph — one markup, so the two cannot differ.
 *
 * `active` draws its active form (when it has one), its mask ids under
 * `activeIds` — unique in the document: the sheet's symbol id, an inline
 * icon's own.
 */
export function familyGlyphBody(
  family: InlineIconFamily,
  glyph: IconGlyph,
  active?: { ids: string },
): string {
  const paint =
    glyph.paint === "fill"
      ? 'fill="currentColor" stroke="none"'
      : strokePaint(family);
  const body =
    active !== undefined && glyph.active !== undefined
      ? placeActiveIds(glyph.active, active.ids)
      : glyph.body;
  return `<g ${paint}>${body}</g>`;
}

/**
 * The `<symbol>` markup of every glyph of an inline family, for the sheet —
 * each glyph's active form beside it, and, for a strict family, its gap glyph.
 */
export function familyGlyphMarkup(family: InlineIconFamily): string {
  const symbols = Object.entries<IconGlyph>(family.glyphs).flatMap(
    ([name, glyph]) => [
      `<symbol id="${familyGlyphId(family.id, name)}" viewBox="0 0 24 24">${familyGlyphBody(family, glyph)}</symbol>`,
      ...(glyph.active === undefined
        ? []
        : [
            `<symbol id="${familyGlyphId(family.id, name, true)}" viewBox="0 0 24 24">${familyGlyphBody(family, glyph, { ids: familyGlyphId(family.id, name, true) })}</symbol>`,
          ]),
    ],
  );
  if (family.coverage === "strict") {
    symbols.push(
      `<symbol id="${familyGapId(family.id)}" viewBox="0 0 24 24"><g ${strokePaint(family)}>${GAP_BODY}</g></symbol>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>`;
}
