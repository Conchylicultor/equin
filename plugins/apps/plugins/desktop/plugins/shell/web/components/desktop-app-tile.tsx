import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  AppIconTile,
  DEFAULT_APP_ICON,
} from "@plugins/apps-core/plugins/app-icon/web";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";

/** The app a desktop tile draws: its id (which seeds its derived colour) and
 *  its icon — `ActiveApp` and the launcher's apps are both one. */
export interface DesktopTileApp {
  id: string;
  icon: AppIcon;
}

/**
 * An app as the desktop draws it — the shelf, the launcher, the peek and
 * switcher headers, the titlebar's app button: the app's launcher tile
 * (`AppIconTile`), so an app wears the same colour on the desktop as in the
 * Home gallery. `app` undefined (a tab whose app cannot be resolved) draws the
 * fallback glyph on the neutral box.
 *
 * `className` sizes the tile (e.g. `size-11.5`); the squircle corner and the
 * glyph are fixed shares of it. `muted` greys it out (an inactive window).
 */
export function DesktopAppTile({
  app,
  muted,
  className,
}: {
  app: DesktopTileApp | undefined;
  muted?: boolean;
  className?: string;
}) {
  return (
    <AppIconTile
      icon={app?.icon ?? DEFAULT_APP_ICON}
      appId={app?.id}
      className={cn(rigidClass(), muted && "opacity-60 grayscale", className)}
    />
  );
}
