import { createContext, useContext, useMemo, type CSSProperties } from "react";
import { APP_TILE_PALETTE, type AppTilePalette } from "../../core";

/**
 * The palette app tiles below paint in: the shared {@link APP_TILE_PALETTE}
 * (so an app's tile is the colour the Home gallery paints it, whatever theme
 * scope the launcher sits in), unless a launcher with a design of its own
 * hands down another (`AppTilePaletteProvider`).
 */
export const TilePaletteContext =
  createContext<AppTilePalette>(APP_TILE_PALETTE);

/** The palette as the `--categorical-*` vars the avatar's tile fill reads,
 *  set on the tile itself. */
export function useTilePaletteVars(): CSSProperties {
  const palette = useContext(TilePaletteContext);
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(palette).map(([k, v]) => [`--${k}`, v]),
      ) as CSSProperties,
    [palette],
  );
}
