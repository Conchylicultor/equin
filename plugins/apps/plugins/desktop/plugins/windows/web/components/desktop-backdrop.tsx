import {
  DesktopContextMenu,
  WallpaperAttribution,
} from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { useOverviewActive } from "../internal/overview";
import { DesktopWallpaper } from "./desktop-wallpaper";

/**
 * The floating placement's {@link PlacementDef.Backdrop}: the desktop layer that
 * sits BELOW every window (the surface body renders backdrops before the tab
 * containers). Composes three things, all desktop-level:
 *
 * 1. {@link DesktopWallpaper} — the full-bleed image or default gradient.
 * 2. {@link DesktopContextMenu} — the transparent right-click capture layer.
 *    Living in the backdrop (below windows) is what guarantees a right-click on a
 *    window reaches the window's own system menu, while a right-click on the empty
 *    desktop reaches this menu.
 * 3. {@link WallpaperAttribution} — the unobtrusive corner credit.
 *
 * A full-bleed `<Layer>` host so the capture layer's own full-bleed box and the
 * attribution's corner `Pin` anchor to the desktop, not to the surface.
 */
export function DesktopBackdrop() {
  const overview = useOverviewActive();
  return (
    <Layer>
      <DesktopWallpaper />
      <DesktopContextMenu />
      <WallpaperAttribution hidden={overview} />
    </Layer>
  );
}
