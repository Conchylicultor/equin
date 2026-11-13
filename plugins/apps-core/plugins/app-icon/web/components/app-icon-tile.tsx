import {
  Avatar,
  AvatarPresentationProvider,
} from "@plugins/primitives/plugins/avatar/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { AppIcon } from "../../core";
import { useTilePaletteVars } from "../internal/tile-palette";

/**
 * An app's icon as its launcher TILE: the glyph on a squircle in the app's
 * declared colour (`icon.color`), or one derived from `appId` when it declares
 * none — the same tile the Home gallery draws, so an app looks the same in
 * every launcher. `className` sizes the tile (e.g. `size-9`); the glyph is a
 * fixed share of it. `appId` undefined (an app that cannot be resolved) and no
 * declared colour draws the neutral box. It paints in the app-tile palette
 * (`APP_TILE_PALETTE`, or the one an enclosing `AppTilePaletteProvider` hands
 * down), not the enclosing theme's categorical slots.
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
  const paletteVars = useTilePaletteVars();
  switch (icon.kind) {
    case "symbol":
      return (
        <span
          aria-hidden
          className={cn("block", className)}
          style={paletteVars}
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
  const paletteVars = useTilePaletteVars();
  switch (icon.kind) {
    case "symbol":
      return (
        <span aria-hidden className="block size-full" style={paletteVars}>
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
