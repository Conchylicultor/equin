import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  DesktopAppTile,
  type DesktopTileApp,
} from "@plugins/apps/plugins/desktop/plugins/shell/web";

/**
 * The desktop's app tile at one of the window chrome's small sizes — the
 * titlebar's app button (18px, 5px corner), the tab-drag ghost and the merge
 * menu (16px, 4px corner). The mockup draws these at fixed pixel sizes whatever
 * the app's density, so the box is sized here and the tile fills it.
 */
export function WindowAppTile({
  app,
  size,
  radius,
  muted,
}: {
  app: DesktopTileApp | undefined;
  size: number;
  radius: number;
  muted?: boolean;
}) {
  return (
    <Clip
      className={rigidClass()}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <DesktopAppTile app={app} muted={muted} className="size-full" />
    </Clip>
  );
}
