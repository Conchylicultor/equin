import type { ReactNode } from "react";
import { developerSymbol } from "@plugins/audience/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";

const TOOLTIP = "Developer only — shown because Developer mode is on";

/**
 * The mark of something only a developer is shown — the developer symbol
 * (Developer mode's own glyph) on a pill in the primary tint. Every surface
 * that shows a developer-only thing draws THIS, so a developer learns one
 * symbol: inline beside a title (a notification, a toast), or `corner` — the
 * same pill on an opaque ground ringed in the surface's colour, so a tile
 * under it does not show through the tint ({@link DeveloperCorner}).
 */
export function DeveloperMark({
  placement = "inline",
}: {
  placement?: "inline" | "corner";
}) {
  const mark = (
    <Inline
      gap="none"
      justify="center"
      role="img"
      aria-label="Developer only"
      className="h-4 w-6 rounded-full bg-primary/15 align-middle text-primary-text"
    >
      <Icon icon={developerSymbol} className="size-3" />
    </Inline>
  );
  return (
    <WithTooltip content={TOOLTIP}>
      {placement === "inline" ? (
        mark
      ) : (
        <Inline
          gap="none"
          className="rounded-full bg-background ring-2 ring-background"
        >
          {mark}
        </Inline>
      )}
    </WithTooltip>
  );
}

/**
 * `children` (a tile, an icon) with the {@link DeveloperMark} overhanging its
 * top-left corner when `developer` — what a launcher draws on a developer
 * app's tile. Top-left, because the top-right corner is the app's own badge
 * (unread mail, a conflict) and a tile's row actions. Fills the box it is
 * given, as the tile inside does.
 */
export function DeveloperCorner({
  developer,
  children,
}: {
  developer: boolean;
  children: ReactNode;
}) {
  if (!developer) return children;
  return (
    <span className="relative block size-full">
      {children}
      <Pin to="top-left" offset="xs" outset>
        <DeveloperMark placement="corner" />
      </Pin>
    </span>
  );
}
