import {
  Avatar,
  AvatarPresentationProvider,
} from "@plugins/primitives/plugins/avatar/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { APP_TILE_PALETTE, type AppIcon } from "../../core";

/** The app-tile palette as the `--categorical-*` vars the avatar's flat tile
 *  fill reads, set on the tile itself — so the tile is the colour the Home
 *  gallery paints it, whatever theme scope the launcher sits in. */
const TILE_PALETTE_VARS = Object.fromEntries(
  Object.entries(APP_TILE_PALETTE).map(([k, v]) => [`--${k}`, v]),
) as React.CSSProperties;

/**
 * An app's icon as its launcher TILE: the glyph on a squircle in the app's
 * declared colour (`icon.color`), or one derived from `appId` when it declares
 * none — the same tile the Home gallery draws, so an app looks the same in
 * every launcher. `className` sizes the tile (e.g. `size-9`); the glyph is a
 * fixed share of it. `appId` undefined (an app that cannot be resolved) and no
 * declared colour draws the neutral box. It paints in `APP_TILE_PALETTE`, not the enclosing
 * theme's categorical slots.
 */
export function AppIconTile({
  icon,
  appId,
  className,
}: {
  icon: AppIcon;
  /** Seeds the derived colour when the icon declares none. */
  appId: string | undefined;
  className?: string;
}) {
  switch (icon.kind) {
    case "symbol":
      return (
        <span
          aria-hidden
          className={cn("block", className)}
          style={TILE_PALETTE_VARS}
        >
          <AvatarPresentationProvider value="tile">
            <Avatar
              symbol={icon.symbol}
              color={icon.color ?? null}
              shape="squircle"
              fallbackKey={appId}
            />
          </AvatarPresentationProvider>
        </span>
      );
  }
}

/**
 * An app's icon as a field cell: drawn in the AMBIENT avatar presentation, so
 * the same field is a launcher tile where the view declares tiles (the icons
 * view's `AvatarPresentationProvider value="tile"`, filling the box it gives)
 * and a badge-sized avatar in rows and table cells — where a forced tile would
 * fill a content-sized box, i.e. collapse to nothing. Same colour either way.
 */
export function AppIconAvatar({
  icon,
  appId,
}: {
  icon: AppIcon;
  appId: string;
}) {
  switch (icon.kind) {
    case "symbol":
      return (
        <span aria-hidden className="block size-full" style={TILE_PALETTE_VARS}>
          <Avatar
            symbol={icon.symbol}
            color={icon.color ?? null}
            shape="squircle"
            fallbackKey={appId}
          />
        </span>
      );
  }
}
