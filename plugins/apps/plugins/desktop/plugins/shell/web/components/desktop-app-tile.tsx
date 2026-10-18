import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { desktopThemeScope } from "../internal/theme-scope";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { AppIconView } from "@plugins/apps-core/plugins/app-icon/web";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";

/**
 * An app as the desktop draws it — the shelf, the launcher, the peek and
 * switcher headers, the titlebar's app button: its glyph in white on a
 * squircle filled with the desktop theme's accent gradient (lighter at the top
 * left, the accent at the bottom right), with the mockup's inset hairline and
 * 1px drop. One fill for every app for now — the tile reads the theme, so a
 * per-app colour later is a change here only.
 *
 * The tile is its own `app:desktop` theme boundary: it is drawn inside windows
 * too (the titlebar's app button), where the enclosing theme is the window's
 * app's — whose accent is not the desktop's.
 *
 * `className` sizes the tile and its corner (e.g. `size-11.5 rounded-xl`); the
 * glyph is a fixed share of it. `muted` greys it out (an inactive window).
 */
export function DesktopAppTile({
  icon,
  muted,
  className,
}: {
  icon: AppIcon;
  muted?: boolean;
  className?: string;
}) {
  return (
    <Theme
      name={desktopThemeScope}
      surface="none"
      as={Center}
      aria-hidden
      className={cn(
        rigidClass(),
        "text-white",
        "bg-[linear-gradient(160deg,color-mix(in_oklab,var(--primary)_72%,white),var(--primary))]",
        "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.18)]",
        muted && "opacity-60 grayscale",
        className,
      )}
    >
      <AppIconView icon={icon} className="size-[52%]" />
    </Theme>
  );
}
