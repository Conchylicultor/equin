import {
  BRANDS_SPRITE,
  DEFAULT_ICON_STYLE,
  SETI_SPRITE,
  MATERIAL_FAMILY,
  brandId,
  familyGapId,
  familyGlyphId,
  familyGlyphOf,
  runtimeSymbolId,
  setiId,
  styleKeyOf,
  symbolId,
  type IconFamily,
  type IconFamilyId,
  type IconRef,
  type IconStyle,
  type SpriteKey,
  type StyleKey,
  type SymbolName,
} from "../../core";
import { hasSprite } from "./sprite-store";
import { hasRuntimeSymbol } from "./runtime-symbol-store";
import { iconFamily } from "./family-store";

/** Where a drawn symbol's markup lives. */
export type DrawingSource =
  | { kind: "sprite"; key: SpriteKey }
  | { kind: "runtime" }
  | { kind: "family"; family: string; glyph: string }
  /** A strict family's gap glyph, standing in for `name` it does not map. */
  | { kind: "gap"; family: string; name: SymbolName };

/** Something a drawing is still waiting for, to ask its loader for. */
export type DrawingWant =
  | { kind: "sprite"; key: SpriteKey }
  | { kind: "runtime"; styleKey: StyleKey; name: string };

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
 * The first family of the chain that draws `name` and holds its drawing, plus
 * the sprites wanted on the way (a sprite family that maps the name but has
 * not loaded yet: the next family draws until it lands). `strictEnd` is the
 * chain's last family when it is strict: past it, nothing else may draw.
 */
function familyDrawing(
  familyId: string,
  name: SymbolName,
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
        drawing: {
          id: familyGlyphId(f.id, id),
          source: { kind: "family", family: f.id, glyph: id },
        },
        wants,
        strictEnd: undefined,
      };
    }
    if (hasSprite(f.sprite)) {
      return {
        drawing: { id, source: { kind: "sprite", key: f.sprite } },
        wants,
        strictEnd: undefined,
      };
    }
    wants.push({ kind: "sprite", key: f.sprite });
  }
  const last = chain.at(-1);
  return {
    drawing: null,
    wants,
    strictEnd: last?.coverage === "strict" ? last.id : undefined,
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
): {
  drawing: Drawing | null;
  wants: readonly DrawingWant[];
} {
  const key = styleKeyOf(style, active);
  const defaultKey = styleKeyOf(DEFAULT_ICON_STYLE, active);
  switch (icon.kind) {
    case "brand":
      return {
        drawing: {
          id: brandId(icon.name),
          source: { kind: "sprite", key: BRANDS_SPRITE },
        },
        wants: [],
      };
    case "seti":
      return {
        drawing: hasSprite(SETI_SPRITE)
          ? {
              id: setiId(icon.name),
              source: { kind: "sprite", key: SETI_SPRITE },
            }
          : null,
        wants: hasSprite(SETI_SPRITE)
          ? []
          : [{ kind: "sprite", key: SETI_SPRITE }],
      };
    case "runtime-symbol": {
      const wants: DrawingWant[] = hasRuntimeSymbol(key, icon.name)
        ? []
        : [{ kind: "runtime", styleKey: key, name: icon.name }];
      const drawn = hasRuntimeSymbol(key, icon.name)
        ? key
        : hasRuntimeSymbol(defaultKey, icon.name)
          ? defaultKey
          : null;
      return {
        drawing:
          drawn === null
            ? null
            : {
                id: runtimeSymbolId(drawn, icon.name),
                source: { kind: "runtime" },
              },
        wants,
      };
    }
    case "custom": {
      const f = iconFamily(icon.family);
      if (f === undefined) return { drawing: null, wants: [] };
      if (f.kind !== "inline" || !(icon.name in f.glyphs)) {
        throw new Error(
          `[icons] icon family "${icon.family}" draws no glyph "${icon.name}"`,
        );
      }
      return {
        drawing: {
          id: familyGlyphId(f.id, icon.name),
          source: { kind: "family", family: f.id, glyph: icon.name },
        },
        wants: [],
      };
    }
    case "symbol": {
      const family = familyDrawing(style.family, icon.name);
      if (family.drawing !== null) return family;
      if (family.strictEnd !== undefined) {
        // A strict family's scope never borrows another family's drawing: an
        // unmapped name is its gap glyph — or, while a sprite family earlier in
        // the chain that maps it is loading, nothing yet.
        return {
          drawing:
            family.wants.length > 0
              ? null
              : {
                  id: familyGapId(family.strictEnd),
                  source: {
                    kind: "gap",
                    family: family.strictEnd,
                    name: icon.name,
                  },
                },
          wants: family.wants,
        };
      }
      const drawnKey = hasSprite(key) ? key : defaultKey;
      return {
        drawing: {
          id: symbolId(drawnKey, icon.name),
          source: { kind: "sprite", key: drawnKey },
        },
        wants: family.wants,
      };
    }
  }
}
