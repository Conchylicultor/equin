import type { MouseEvent, PointerEvent } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { DesktopAppTile } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import type { ShelfAppEntry } from "../internal/use-shelf-model";

/** How many pips an entry draws under its tile, at most (mockup). */
const MAX_PIPS = 3;

/**
 * One app on the dock (mockup `.sh-item`, `dock` + `grouped`): the app's
 * 46px tile, lifting 4px on hover and pressing to .97; under it one pip per
 * window (up to three), accent-coloured while the focused window is one of
 * them; the app's own badge at the top-right corner. The window count the
 * mockup prints beside a grouped entry is hidden in the dock variant, so the
 * pips are the count.
 *
 * `ref` registers the entry's element, so the peek and the menu can anchor on
 * it and a minimising window can aim at it.
 */
export function ShelfEntryButton({
  entry,
  active,
  ref,
  onClick,
  onAuxClick,
  onContextMenu,
  onPointerOver,
}: {
  entry: ShelfAppEntry;
  /** The focused window is one of this entry's windows. */
  active: boolean;
  ref: (el: HTMLButtonElement | null) => void;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onAuxClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>) => void;
  onPointerOver: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const { app, windows } = entry;
  const Badge = app.badge;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={app.app.name}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
      onPointerOver={onPointerOver}
      className={cn(
        "relative size-11.5 max-[760px]:size-9.5",
        rigidClass(),
        "transition-transform duration-[180ms] ease-[cubic-bezier(.2,.8,.2,1)]",
        "hover:-translate-y-1 active:-translate-y-0.5 active:scale-[0.97]",
      )}
    >
      <DesktopAppTile app={app} className="size-11.5 max-[760px]:size-9.5" />
      {Badge && (
        // eslint-disable-next-line layout/no-adhoc-layout -- the app's badge overhangs the tile's top-right corner by the mockup's 4px
        <span className="pointer-events-none absolute -top-1 -right-1">
          <Badge />
        </span>
      )}
      {windows.length > 0 && (
        <span
          aria-hidden
          // eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the pips hang 5px below the tile, centred, 3px apart (mockup `.pips`); neither length is on the ramp
          className="pointer-events-none absolute -bottom-[5px] left-1/2 flex -translate-x-1/2 gap-[3px]"
        >
          {windows.slice(0, MAX_PIPS).map((w) => (
            <i
              key={w.id}
              className={cn(
                "block size-1 rounded-full",
                active ? "bg-primary" : "bg-foreground/60",
              )}
            />
          ))}
        </span>
      )}
    </button>
  );
}
