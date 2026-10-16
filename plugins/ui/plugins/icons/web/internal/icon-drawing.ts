import {
  BRANDS_SPRITE,
  DEFAULT_ICON_STYLE,
  LUCIDE_SPRITE,
  SETI_SPRITE,
  brandId,
  lucideId,
  lucideNameOf,
  runtimeSymbolId,
  setiId,
  styleKeyOf,
  symbolId,
  type IconRef,
  type IconStyle,
  type SpriteKey,
  type StyleKey,
} from "../../core";
import { hasSprite } from "./sprite-store";
import { hasRuntimeSymbol } from "./runtime-symbol-store";

/** Where a drawn symbol's markup lives. */
export type DrawingSource =
  { kind: "sprite"; key: SpriteKey } | { kind: "runtime" };

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
export function resolveIconDrawing(
  icon: IconRef,
  style: IconStyle,
  active: boolean,
): {
  drawing: { id: string; source: DrawingSource } | null;
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
    case "symbol": {
      const isLucide =
        style.family === "lucide" && lucideNameOf(icon.name) !== undefined;
      if (isLucide && hasSprite(LUCIDE_SPRITE)) {
        return {
          drawing: {
            id: lucideId(icon.name),
            source: { kind: "sprite", key: LUCIDE_SPRITE },
          },
          wants: [],
        };
      }
      const drawnKey = hasSprite(key) ? key : defaultKey;
      return {
        drawing: {
          id: symbolId(drawnKey, icon.name),
          source: { kind: "sprite", key: drawnKey },
        },
        wants: isLucide ? [{ kind: "sprite", key: LUCIDE_SPRITE }] : [],
      };
    }
  }
}
