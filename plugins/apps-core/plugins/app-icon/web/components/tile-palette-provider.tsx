import type { ReactNode } from "react";
import type { AppTilePalette } from "../../core";
import { TilePaletteContext } from "../internal/tile-palette";

/**
 * Paints every app tile below (`AppIconTile`, `AppIconAvatar`) in `palette`
 * instead of the shared `APP_TILE_PALETTE` — for a launcher whose design
 * gives tiles a palette of its own (the menu-bar panel's vivid tiles). The
 * pick per app is unchanged (its declared colour, else one from its id); only
 * the colour each slot paints changes.
 */
export function AppTilePaletteProvider({
  palette,
  children,
}: {
  palette: AppTilePalette;
  children: ReactNode;
}) {
  return (
    <TilePaletteContext.Provider value={palette}>
      {children}
    </TilePaletteContext.Provider>
  );
}
