import { createContext, useContext, type ReactNode } from "react";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { fixedThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { MapTileScheme } from "../../core";
import { mapChromeThemes } from "../internal/map-chrome-theme";

/** The tile scheme of the map this subtree sits in, set by `MapView` from its renderer. */
const MapTilesContext = createContext<MapTileScheme | null>(null);

/** Provides the renderer's tile scheme to every {@link MapChrome} inside the map. */
export function MapTilesProvider({
  tiles,
  children,
}: {
  tiles: MapTileScheme;
  children: ReactNode;
}) {
  return (
    <MapTilesContext.Provider value={tiles}>
      {children}
    </MapTilesContext.Provider>
  );
}

/**
 * The theme boundary for chrome drawn OVER the map's tiles — a renderer's own
 * controls (Fit), and through `MapView`'s `controls` a host's: it wears the
 * map-chrome fixed theme of the tiles' scheme, so controls over light tiles
 * are light whatever the app's scheme, and so are the tooltips and popovers
 * they open. It paints nothing and lays nothing out (`display: contents`):
 * what is inside places itself (a `Pin`, a renderer's control slot).
 *
 * Only inside a `MapView` — the tile scheme is the map's renderer's — and
 * never around pins: they resolve their colours in the app's own scope.
 */
export function MapChrome({ children }: { children: ReactNode }) {
  const tiles = useContext(MapTilesContext);
  if (tiles === null) {
    throw new Error("MapChrome: rendered outside a MapView");
  }
  return (
    <Theme
      name={fixedThemeScope(mapChromeThemes[tiles])}
      surface="none"
      className="contents"
    >
      {children}
    </Theme>
  );
}
