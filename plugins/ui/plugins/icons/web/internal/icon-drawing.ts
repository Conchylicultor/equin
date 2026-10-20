import {
  BRANDS_SPRITE,
  DEFAULT_ICON_STYLE,
  SETI_SPRITE,
  brandId,
  familyGlyphId,
  runtimeSymbolId,
  setiId,
  styleKeyOf,
  symbolId,
  type IconFamily,
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
  | { kind: "family"; family: string };

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
 * not loaded yet: the next family draws until it lands).
 */
function familyDrawing(
  familyId: string,
  name: SymbolName,
): { drawing: Drawing | null; wants: DrawingWant[] } {
  const wants: DrawingWant[] = [];
  for (const f of familyChain(familyId)) {
    if (f.kind === "inline") {
      const glyph = f.symbols[name];
      if (glyph === undefined) continue;
      return {
        drawing: {
          id: familyGlyphId(f.id, glyph),
          source: { kind: "family", family: f.id },
        },
        wants,
      };
    }
    const id = f.idOf(name);
    if (id === undefined) continue;
    if (hasSprite(f.sprite)) {
      return {
        drawing: { id, source: { kind: "sprite", key: f.sprite } },
        wants,
      };
    }
    wants.push({ kind: "sprite", key: f.sprite });
  }
  return { drawing: null, wants };
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
          source: { kind: "family", family: f.id },
        },
        wants: [],
      };
    }
    case "symbol": {
      const family = familyDrawing(style.family, icon.name);
      if (family.drawing !== null) return family;
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
