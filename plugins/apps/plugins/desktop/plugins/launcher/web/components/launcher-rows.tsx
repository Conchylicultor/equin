import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { useRevealOnActive } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { DesktopAppTile } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import type { LauncherApp } from "../internal/use-launcher-apps";
import type { LauncherCommand } from "../internal/use-launcher-commands";

/** What every selectable cell and row shares: its place in the listing, whether
 * it is the selection, and the pointer / click wiring. */
export interface CellWiring {
  index: number;
  selected: boolean;
  onHover(index: number): void;
  onRun(index: number, newWindow: boolean): void;
}

interface CellProps {
  index: number;
  selected: boolean;
  onHover(index: number): void;
  onRun(index: number, newWindow: boolean): void;
  onContextMenu?(e: React.MouseEvent): void;
}

/** A selected cell / row is washed with the accent, like the mockup's `--bg-select`. */
const SELECTED = "bg-primary/15";

/** A group heading ("All apps", "Apps", "Commands"). */
export function GroupHeader({ children }: { children: ReactNode }) {
  return (
    <Text variant="eyebrow" tone="muted" as="div" className="px-sm pt-sm pb-xs">
      {children}
    </Text>
  );
}

/** The accent dot that says an app has a window on this desktop. */
function RunningDot() {
  return (
    <span
      aria-hidden
      className={cn(rigidClass(), "size-1.25 rounded-full bg-primary")}
    />
  );
}

/** One app in the empty-query grid: tile over name, a dot when it is running. */
export function AppGridCell({
  app,
  index,
  selected,
  onHover,
  onRun,
  onContextMenu,
}: CellProps & { app: LauncherApp }) {
  const reveal = useRevealOnActive(selected, { scope: "nearest" });
  return (
    <Stack
      ref={reveal}
      as="button"
      gap="sm"
      align="center"
      data-index={index}
      tabIndex={-1}
      // Keep focus in the search field: a click selects, it does not move focus.
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={() => onHover(index)}
      onClick={(e) => onRun(index, e.shiftKey)}
      onContextMenu={onContextMenu}
      className={cn(
        yieldClass("x"),
        "rounded-xl px-xs pt-md pb-sm",
        selected && SELECTED,
      )}
    >
      <DesktopAppTile icon={app.icon} className="size-12 rounded-xl" />
      <Stack
        direction="row"
        gap="xs"
        align="center"
        justify="center"
        className="max-w-full"
      >
        {app.windows > 0 && <RunningDot />}
        <Text variant="caption" className="truncate font-medium">
          {app.name}
        </Text>
      </Stack>
    </Stack>
  );
}

/** One app in a search listing: tile, name, "N windows", and what picking it does. */
export function AppRow({
  app,
  index,
  selected,
  onHover,
  onRun,
  onContextMenu,
}: CellProps & { app: LauncherApp }) {
  const reveal = useRevealOnActive(selected, { scope: "nearest" });
  return (
    <Line
      ref={reveal}
      as="button"
      data-index={index}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={() => onHover(index)}
      onClick={(e) => onRun(index, e.shiftKey)}
      onContextMenu={onContextMenu}
      className={cn(
        "w-full gap-md rounded-lg px-sm py-xs text-left",
        selected && SELECTED,
      )}
    >
      <DesktopAppTile icon={app.icon} className="size-6.5 rounded-md" />
      <Text variant="label" className={cn(rigidClass(), "font-semibold")}>
        {app.name}
      </Text>
      <Fill>
        <Text variant="caption" tone="muted">
          {app.windows > 1 ? `${app.windows} windows` : ""}
        </Text>
      </Fill>
      <Text variant="caption" tone="muted" className={rigidClass()}>
        {app.windows > 0 ? "Switch to" : "Open"}
      </Text>
    </Line>
  );
}

/** One command in a search listing: glyph, label, and the key that runs it. */
export function CommandRow({
  command,
  index,
  selected,
  onHover,
  onRun,
}: CellProps & { command: LauncherCommand }) {
  const reveal = useRevealOnActive(selected, { scope: "nearest" });
  return (
    <Line
      ref={reveal}
      as="button"
      data-index={index}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={() => onHover(index)}
      onClick={(e) => onRun(index, e.shiftKey)}
      className={cn(
        "w-full gap-md rounded-lg px-sm py-xs text-left",
        selected && SELECTED,
      )}
    >
      <Stack
        gap="none"
        align="center"
        justify="center"
        className={cn(
          rigidClass(),
          "size-6.5 rounded-md bg-muted text-muted-foreground",
        )}
      >
        <Icon icon={command.icon} className="size-4" />
      </Stack>
      <Text variant="label" className={cn(rigidClass(), "font-semibold")}>
        {command.label}
      </Text>
      <Fill />
      {command.hint !== undefined && <Kbd>{command.hint}</Kbd>}
    </Line>
  );
}
