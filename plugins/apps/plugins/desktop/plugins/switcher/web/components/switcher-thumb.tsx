import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ActiveApp } from "@plugins/apps-core/web";
import { DesktopAppTile } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import {
  WindowSnapshot,
  type FloatingWindow,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";

/** The largest a switcher snapshot gets, as in the mockup. */
const THUMB_MAX_W = 210;
const THUMB_MAX_H = 140;

/**
 * One window in the switcher: a header (app tile, window title, "N tabs") over
 * a static snapshot. The selected one is washed with the accent and its
 * snapshot ringed; a minimised window's snapshot is dimmed and desaturated.
 */
export function SwitcherThumb({
  window: w,
  app,
  title,
  tabCount,
  selected,
  onPick,
}: {
  window: FloatingWindow;
  app: ActiveApp;
  title: string | undefined;
  tabCount: number;
  selected: boolean;
  onPick(): void;
}) {
  return (
    <Stack
      gap="none"
      onClick={onPick}
      className={cn("rounded-xl p-sm", selected && "bg-primary/15")}
    >
      {/* The header is as wide as the snapshot, never wider: w-0 + min-w-full
          takes the column's width from the snapshot below it. */}
      <Line className="h-6.5 w-0 min-w-full gap-sm pb-xs">
        <DesktopAppTile icon={app.icon} className="size-4 rounded-sm" />
        <Fill>
          <Text variant="caption" className="font-semibold">
            {title ?? app.app.name}
          </Text>
        </Fill>
        {tabCount > 1 && (
          <Text variant="caption" tone="muted" className={rigidClass()}>
            {tabCount} tabs
          </Text>
        )}
      </Line>
      <div
        className={cn(
          "rounded-md bg-background",
          selected ? "ring-2 ring-primary" : "ring-1 ring-border",
          w.geo.minimized && "opacity-60 saturate-[0.4]",
        )}
      >
        <WindowSnapshot window={w} maxW={THUMB_MAX_W} maxH={THUMB_MAX_H} />
      </div>
    </Stack>
  );
}
