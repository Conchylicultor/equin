import {
  BRANDS_SPRITE,
  DEFAULT_ICON_STYLE,
  SETI_SPRITE,
  MATERIAL_FAMILY,
  brandId,
  familyGapId,
  familyGlyphId,
  familyGlyphOf,
  setiId,
  styleKeyOf,
  type IconFamily,
  type IconFamilyId,
  type IconRef,
  type IconStyle,
  type GlyphKey,
  type SpriteKey,
  type StyleKey,
  type SymbolName,
} from "../../core";
import { hasSprite, spriteHolds } from "./sprite-store";
import {
  pageRuntimeSymbols,
  type RuntimeSymbolStore,
} from "./runtime-symbol-store";
import { iconFamily } from "./family-store";

/** Where a drawn symbol's markup lives. */
export type DrawingSource =
  | { kind: "sprite"; key: SpriteKey }
  /** A glyph of `store` (a Material symbol in some style, a Lucide glyph). */
  | { kind: "runtime"; store: RuntimeSymbolStore }
  /** `active`: the glyph's active form is drawn (it has one, and the icon is active). */
  | { kind: "family"; family: string; glyph: string; active: boolean }
  /** A strict family's gap glyph, standing in for `name` it does not map. */
  | { kind: "gap"; family: string; name: SymbolName }
  /**
   * Sprite `sprite` is held but has no `<symbol id="<id>">`: the build's icon
   * manifest is out of step with the code naming the icon. Drawn as the
   * missing-glyph marker and reported (`iconMissingGlyphReportSink`) — never a
   * `<use>` of nothing, which draws an empty box and tells no one. A glyph
   * its server answered without a drawing is missing the same way.
   */
  | { kind: "missing"; sprite: SpriteKey; id: string };

/** Something a drawing is still waiting for, to ask its loader for. */
export type DrawingWant =
  | { kind: "sprite"; key: SpriteKey; store: RuntimeSymbolStore }
  | { kind: "glyph"; key: GlyphKey; name: string; store: RuntimeSymbolStore };

/**
 * The stores an icon's glyphs come from. `saved` — the store a saved icon of
 * this part of the page draws from (a plugin scope's own, or one that refuses
 * when the scope mounted none). `family` — where a sprite family's glyphs
 * (Lucide) come from: the scope's own store when it mounted one, else the
 * page's. Code Material symbols always come from the PAGE's store: the same
 * drawing whichever server draws it, and a scope's server (a browser host)
 * would load its whole bundled set for a name it has not cached.
 */
export interface IconStores {
  readonly saved: RuntimeSymbolStore;
  readonly family: RuntimeSymbolStore;
}

/**
 * Which symbol draws `icon` in `style` right now — the ONE answer `<Icon>` and
 * `useIconMarkup` both take, so a glyph drawn in the DOM and the same glyph
 * drawn from its markup can never be two different drawings.
 *
 * `drawing` is `null` while nothing that could draw it is held (a loading
 * state); `wants` lists what to ask for: the style's own drawing whenever a
 * fallback (or nothing) stands in for it.
 */
type Drawing = { id: string; source: DrawingSource };

/** The id that stands for a missing glyph: never `<use>`d (`<Icon>` draws it inline). */
export const MISSING_GLYPH_ID = "icon-missing-glyph";

/**
 * Symbol `id` from held sprite `key` — or, when the sprite is held and lacks
 * it, the missing-glyph drawing. Only for a sprite the caller knows is held.
 */
function fromSprite(key: SpriteKey, id: string): Drawing {
  return spriteHolds(key, id) === false
    ? { id: MISSING_GLYPH_ID, source: { kind: "missing", sprite: key, id } }
    : { id, source: { kind: "sprite", key } };
}

/**
 * Glyph `name` of `key` from `store`: drawn once held, the missing-glyph marker
 * when its server answered without it, `null` while it loads.
 */
function fromGlyph(
  store: RuntimeSymbolStore,
  key: GlyphKey,
  name: string,
): Drawing | null {
  if (store.hasSymbol(key, name)) {
    return {
      id: store.symbolId(key, name),
      source: { kind: "runtime", store },
    };
  }
  if (store.isMissing(key, name)) {
    const id = store.symbolId(key, name);
    return {
      id: MISSING_GLYPH_ID,
      source: { kind: "missing", sprite: key, id },
    };
  }
  return null;
}

/**
 * The families a scope of family `id` draws a symbol from, in order: the
 * family, its fallback, and so on. Material ends every chain and is not in it;
 * a family not (yet) contributed ends it early. A fallback cycle throws.
 */
function familyChain(id: string): readonly IconFamily[] {
  const chain: IconFamily[] = [];
  for (let f = iconFamily(id); f !== undefined;) {
    if (chain.includes(f)) {
      throw new Error(
        `[icons] icon family fallbacks loop: ${[...chain, f].map((x) => x.id).join(" → ")}`,
      );
    }
    chain.push(f);
    f = f.fallback === undefined ? undefined : iconFamily(f.fallback);
  }
  return chain;
}

/**
 * The first family of the chain that maps `name`, and its drawing — `null`,
 * with the glyph wanted, while a sprite family's glyph loads. `strictEnd` is
 * the chain's last family when it is strict: past it, nothing else may draw.
 *
 * `active` (the icon is active AND its scope fills active icons) draws the
 * family's active form: an inline glyph's own, a sprite family's from its
 * `activeSprite` — the drawing at rest standing in while that loads.
 */
function familyDrawing(
  familyId: string,
  name: SymbolName,
  active: boolean,
  store: RuntimeSymbolStore,
): {
  drawing: Drawing | null;
  wants: DrawingWant[];
  strictEnd: IconFamilyId | undefined;
} {
  const wants: DrawingWant[] = [];
  const chain = familyChain(familyId);
  for (const f of chain) {
    const id = familyGlyphOf(f, name);
    if (id === undefined) continue;
    if (f.kind === "inline") {
      return {
        drawing: inlineGlyphDrawing(f, id, active),
        wants,
        strictEnd: undefined,
      };
    }
    // A sprite family that maps the name draws it — or nothing yet while its
    // glyph loads (the first frame waits for it): never another family's
    // drawing to be swapped out a moment later, and no fallback glyph fetched
    // for nothing.
    if (active && f.activeSprite !== undefined) {
      const drawn = fromGlyph(store, f.activeSprite, name);
      if (drawn !== null)
        return { drawing: drawn, wants, strictEnd: undefined };
      wants.push({ kind: "glyph", key: f.activeSprite, name, store });
      // The drawing at rest stands in while the active form loads, if held.
      if (store.hasSymbol(f.sprite, name)) {
        return {
          drawing: fromGlyph(store, f.sprite, name),
          wants,
          strictEnd: undefined,
        };
      }
      return { drawing: null, wants, strictEnd: undefined };
    }
    const drawn = fromGlyph(store, f.sprite, name);
    if (drawn === null)
      wants.push({ kind: "glyph", key: f.sprite, name, store });
    return { drawing: drawn, wants, strictEnd: undefined };
  }
  const last = chain.at(-1);
  return {
    drawing: null,
    wants,
    strictEnd: last?.coverage === "strict" ? last.id : undefined,
  };
}

/** An inline family's glyph — its active form when `active` and it has one. */
function inlineGlyphDrawing(
  f: IconFamily & { kind: "inline" },
  glyph: string,
  active: boolean,
): Drawing {
  const drawActive = active && f.glyphs[glyph]?.active !== undefined;
  return {
    id: familyGlyphId(f.id, glyph, drawActive),
    source: { kind: "family", family: f.id, glyph, active: drawActive },
  };
}

/**
 * Where the family `familyId` gets its drawing of `name` from — by MAPPING,
 * not by what has loaded: the same chain `<Icon>` walks (`familyChain` +
 * `familyGlyphOf`), so a page listing coverage cannot disagree with what an
 * app draws.
 *
 * - `own` — the family draws it itself (`glyph`: its glyph name, its sprite
 *   symbol id, or — for `material` — the Material name).
 * - `fallback` — a later family of its chain draws it; `material` when the
 *   chain ends without one.
 * - `gap` — the chain ends at a strict family that does not map it: its scopes
 *   draw the gap glyph.
 *
 * A family not (yet) contributed has no chain: `fallback` to `material`.
 */
export type IconSource =
  | { kind: "own"; glyph: string }
  | { kind: "fallback"; family: IconFamilyId }
  | { kind: "gap"; family: IconFamilyId };

export function resolveIconSource(
  name: SymbolName,
  familyId: IconFamilyId,
): IconSource {
  if (familyId === MATERIAL_FAMILY) return { kind: "own", glyph: name };
  const chain = familyChain(familyId);
  for (const f of chain) {
    const glyph = familyGlyphOf(f, name);
    if (glyph === undefined) continue;
    return f.id === familyId
      ? { kind: "own", glyph }
      : { kind: "fallback", family: f.id };
  }
  const last = chain.at(-1);
  return last?.coverage === "strict"
    ? { kind: "gap", family: last.id }
    : { kind: "fallback", family: MATERIAL_FAMILY };
}

export function resolveIconDrawing(
  icon: IconRef,
  style: IconStyle,
  active: boolean,
  stores: IconStores,
): {
  drawing: Drawing | null;
  wants: readonly DrawingWant[];
} {
  const key = styleKeyOf(style, active);
  const defaultKey = styleKeyOf(DEFAULT_ICON_STYLE, active);
  switch (icon.kind) {
    case "brand":
      return {
        drawing: hasSprite(BRANDS_SPRITE)
          ? fromSprite(BRANDS_SPRITE, brandId(icon.name))
          : {
              id: brandId(icon.name),
              source: { kind: "sprite", key: BRANDS_SPRITE },
            },
        wants: [],
      };
    case "seti":
      return {
        drawing: hasSprite(SETI_SPRITE)
          ? fromSprite(SETI_SPRITE, setiId(icon.name))
          : null,
        wants: hasSprite(SETI_SPRITE)
          ? []
          : [{ kind: "sprite", key: SETI_SPRITE, store: stores.saved }],
      };
    case "runtime-symbol":
      return materialDrawing(stores.saved, key, defaultKey, icon.name);
    case "custom": {
      const f = iconFamily(icon.family);
      if (f === undefined) return { drawing: null, wants: [] };
      if (f.kind !== "inline" || !(icon.name in f.glyphs)) {
        throw new Error(
          `[icons] icon family "${icon.family}" draws no glyph "${icon.name}"`,
        );
      }
      return {
        drawing: inlineGlyphDrawing(
          f,
          icon.name,
          active && style.activeFill === "filled",
        ),
        wants: [],
      };
    }
    case "symbol": {
      const family = familyDrawing(
        style.family,
        icon.name,
        active && style.activeFill === "filled",
        stores.family,
      );
      if (family.drawing !== null || family.wants.length > 0) {
        return { drawing: family.drawing, wants: family.wants };
      }
      if (family.strictEnd !== undefined) {
        // A strict family's scope never borrows another family's drawing: an
        // unmapped name is its gap glyph — or, while a sprite family earlier in
        // the chain that maps it is loading, nothing yet.
        return {
          drawing: {
            id: familyGapId(family.strictEnd),
            source: { kind: "gap", family: family.strictEnd, name: icon.name },
          },
          wants: [],
        };
      }
      return materialDrawing(pageRuntimeSymbols, key, defaultKey, icon.name);
    }
  }
}

/**
 * A Material glyph in style `key` from `store`: its own drawing once held;
 * until then the default style's (resolved the same way) when held — so a
 * theme switch never blanks an icon — and else nothing yet (a loading state).
 * Wants the style's own glyph whenever it is not held.
 */
function materialDrawing(
  store: RuntimeSymbolStore,
  key: StyleKey,
  defaultKey: StyleKey,
  name: string,
): { drawing: Drawing | null; wants: DrawingWant[] } {
  const own = fromGlyph(store, key, name);
  if (own !== null) return { drawing: own, wants: [] };
  const wants: DrawingWant[] = [{ kind: "glyph", key, name, store }];
  const stand = key === defaultKey ? null : fromGlyph(store, defaultKey, name);
  return {
    drawing: stand?.source.kind === "runtime" ? stand : null,
    wants,
  };
}
