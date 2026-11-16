import type { CSSProperties } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  oklchCss,
  TILE_GRADIENT_ANGLE,
  websiteTileStops,
  type WebsiteTileColor,
} from "../../core";

/**
 * An app's tile on the website: its glyph (46% of the box), white, on a
 * squircle painted with its colour as a diagonal gradient — the deep end
 * top-left, the base bottom-right — inside a hairline inner edge. Bounded and
 * flat, like an app icon on a phone: no gloss, no drop shadow. `className`
 * sizes it (e.g. `size-13`).
 */
export function WebsiteAppTile({
  symbol,
  color,
  className,
}: {
  symbol: SymbolRef;
  color: WebsiteTileColor;
  className?: string;
}) {
  const { deep, base } = websiteTileStops(color);
  const paint = {
    backgroundImage: `linear-gradient(${TILE_GRADIENT_ANGLE}deg, ${oklchCss(deep)}, ${oklchCss(base)})`,
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
      <Icon icon={symbol} className="size-[46%]" />
    </Center>
  );
}
