import type { CSSProperties } from "react";
import {
  appTileColor,
  appTileStops,
  TILE_GRADIENT_ANGLE,
  type OklchColor,
} from "@plugins/apps-core/plugins/app-icon/plugins/tile-colors/core";
import { useAvatarPresentation } from "@plugins/primitives/plugins/avatar/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  cn,
  useControlSize,
  type ControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { AppIcon } from "../../core";

/** The badge box per control size — the avatar's own (`size-avatar-*`), so an app's icon in a row is the size every avatar there is. */
const BADGE_BOX: Record<ControlSize, string> = {
  xs: "size-avatar-xs",
  sm: "size-avatar-sm",
  md: "size-avatar-md",
  lg: "size-avatar-lg",
};

/**
 * A tile colour at the theme's intensity: its chroma scaled by
 * `--app-tile-intensity` (the `app-tile` token group — calm on equin's
 * launchers, vivid on the website), so where a tile is drawn decides how loud
 * it is, never which colour it is.
 */
function themedCss({ l, c, h }: OklchColor): string {
  return `oklch(${l.toFixed(3)} calc(${c} * var(--app-tile-intensity)) ${h})`;
}

/**
 * The tile itself: the app's glyph (46% of the box), white, on a squircle
 * painted with the app's colour as a diagonal gradient — the deep end
 * top-left, the base bottom-right (`tile-colors`) — inside a hairline
 * inner edge. Bounded and flat, like an app icon on a phone: no gloss, no drop
 * shadow, nothing that makes it read as a curved button. Fills its box.
 */
function TileBox({
  icon,
  appId,
  className,
}: {
  icon: AppIcon;
  appId: string | undefined;
  className?: string;
}) {
  // An app that cannot be resolved still gets a colour, from its glyph's name.
  const { deep, base } = appTileStops(
    appTileColor(icon.color, appId ?? icon.symbol.name),
    1,
  );
  const paint = {
    backgroundImage: `linear-gradient(${TILE_GRADIENT_ANGLE}deg, ${themedCss(deep)}, ${themedCss(base)})`,
  } satisfies CSSProperties;
  return (
    <Center
      aria-hidden
      style={paint}
      className={cn(
        "rounded-squircle text-categorical-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/12%)]",
        className,
      )}
    >
      <Icon icon={icon.symbol} className="size-[46%]" />
    </Center>
  );
}

/**
 * An app's icon as its launcher TILE — the same tile wherever an app is drawn
 * (the Home gallery, the launcher grid, the desktop, the website), in the
 * colour the app declares (`defineApp({ iconColor })`), else one picked from
 * `appId`. `className` sizes the tile (e.g. `size-9`).
 */
export function AppIconTile({
  icon,
  appId,
  className,
}: {
  icon: AppIcon;
  /** Seeds the picked colour when the icon declares none. */
  appId: string | undefined;
  className?: string;
}) {
  switch (icon.kind) {
    case "symbol":
      return <TileBox icon={icon} appId={appId} className={className} />;
  }
}

/**
 * An app's icon as a field cell: the same tile, sized by the AMBIENT avatar
 * presentation — filling the box where the view declares tiles (the icons
 * view's `AvatarPresentationProvider value="tile"`), and avatar-sized in rows
 * and table cells, where a box-filling tile would fill a content-sized box,
 * i.e. collapse to nothing.
 */
export function AppIconAvatar({
  icon,
  appId,
}: {
  icon: AppIcon;
  appId: string;
}) {
  const tile = useAvatarPresentation() !== "badge";
  const size = useControlSize();
  switch (icon.kind) {
    case "symbol":
      return (
        <TileBox
          icon={icon}
          appId={appId}
          className={tile ? "size-full" : cn(rigidClass(), BADGE_BOX[size])}
        />
      );
  }
}
