import type { MouseEvent, PointerEvent } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  useWorkAreaReserve,
  windowRectFraction,
  type FloatingWindow,
  type VirtualDesktop,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";

const addIcon = symbol("add");
const closeIcon = symbol("close");
const overviewIcon = symbol("grid-view");

/** A mini-desktop's width in the dock (mockup `renderPager`, `dock`). */
const MINI_W = 54;

/** The windows of one desktop that are on it — not minimised — back to front. */
export function visibleWindowsOf(
  windows: Iterable<FloatingWindow>,
  desktopId: string,
): FloatingWindow[] {
  return [...windows]
    .filter((w) => w.desktopId === desktopId && !w.geo.minimized)
    .sort((a, b) => a.geo.z - b.geo.z);
}

/**
 * The tray's pager (mockup `.pager`): one mini-desktop per virtual desktop —
 * its windows drawn at their real positions, the focused one in the accent —
 * each with a × on hover while there are several desktops; a "+" (shown while
 * the pager is hovered) for a new desktop; then the overview button.
 *
 * Hovering a mini asks for its desktop preview (`onPeekDesktop`), and a
 * right-click asks for its menu — both owned by the shelf, which places them.
 */
export function Pager({
  desktops,
  activeDesktopId,
  windows,
  focusedWindowId,
  desktopW,
  desktopH,
  onSwitch,
  onCreate,
  onRemove,
  onOverview,
  onPeekDesktop,
  onDesktopMenu,
}: {
  desktops: VirtualDesktop[];
  activeDesktopId: string;
  windows: Map<string, FloatingWindow>;
  focusedWindowId: string | null;
  desktopW: number;
  desktopH: number;
  onSwitch: (desktopId: string) => void;
  onCreate: () => void;
  onRemove: (desktopId: string) => void;
  onOverview: () => void;
  onPeekDesktop: (desktopId: string, el: HTMLElement) => void;
  onDesktopMenu: (desktopId: string, el: HTMLElement) => void;
}) {
  // Snapped windows take their tile inside the work area, above the dock.
  const reserve = useWorkAreaReserve();
  const miniH = desktopW > 0 ? Math.round(MINI_W * (desktopH / desktopW)) : 34;
  return (
    // eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the mockup's `.pager` row (gap 5px, off the ramp)
    <div className="group/pager flex items-center gap-[5px]">
      {desktops.map((d, index) => {
        const active = d.id === activeDesktopId;
        const visible = visibleWindowsOf(windows.values(), d.id);
        return (
          <span
            key={d.id}
            className={cn(hoverRevealGroup, "relative block", rigidClass())}
          >
            <button
              type="button"
              aria-label={`Desktop ${index + 1}`}
              aria-pressed={active}
              onClick={() => onSwitch(d.id)}
              onPointerOver={(e: PointerEvent<HTMLButtonElement>) =>
                onPeekDesktop(d.id, e.currentTarget)
              }
              onContextMenu={(e: MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                onDesktopMenu(d.id, e.currentTarget);
              }}
              style={{ width: MINI_W, height: miniH }}
              // eslint-disable-next-line layout/no-adhoc-layout, radius/no-adhoc-radius -- the mini-desktop clips its window rects; the mockup's 5px corner sits between the radius steps
              className={cn(
                "relative block overflow-hidden rounded-[5px] transition-[box-shadow,transform] duration-150",
                active
                  ? "bg-primary/10 shadow-[0_0_0_1.5px_var(--primary)]"
                  : "bg-foreground/9 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_12%,transparent)] hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_30%,transparent)]",
              )}
            >
              {visible.length === 0 ? (
                <Center className="size-full text-3xs font-semibold text-faint-foreground">
                  {index + 1}
                </Center>
              ) : (
                visible.map((w) => {
                  const r = windowRectFraction(
                    w.geo,
                    desktopW,
                    desktopH,
                    reserve,
                  );
                  if (!r) return null;
                  return (
                    <i
                      key={w.id}
                      // eslint-disable-next-line layout/no-adhoc-layout, radius/no-adhoc-radius -- a window's box at its fractional desktop position; the mockup's 1.5px corner
                      className={cn(
                        "absolute block rounded-[1.5px] shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--background)_55%,transparent)]",
                        active && w.id === focusedWindowId
                          ? "bg-primary"
                          : "bg-foreground/32",
                      )}
                      style={{
                        left: `${r.left * 100}%`,
                        top: `${r.top * 100}%`,
                        width: `${r.width * 100}%`,
                        height: `${r.height * 100}%`,
                      }}
                    />
                  );
                })
              )}
            </button>
            {desktops.length > 1 && (
              <button
                type="button"
                title="Close desktop"
                aria-label={`Close desktop ${index + 1}`}
                onClick={() => onRemove(d.id)}
                // eslint-disable-next-line layout/no-adhoc-layout -- the mockup's `.mini-x`: overhangs the mini's top-right corner by 6px
                className={cn(
                  "absolute -top-1.5 -right-1.5 z-raised size-4 rounded-full bg-card text-muted-foreground",
                  "shadow-[0_0_0_0.5px_var(--input),0_1px_3px_rgba(0,0,0,0.2)]",
                  hoverRevealTarget,
                  "scale-80 transition-[opacity,transform] duration-[120ms] group-hover/hover-reveal:scale-100",
                  "hover:bg-destructive hover:text-destructive-foreground",
                )}
              >
                <Center className="size-full">
                  <Icon icon={closeIcon} className="size-2" />
                </Center>
              </button>
            )}
          </span>
        );
      })}
      <button
        type="button"
        title="New desktop"
        aria-label="New desktop"
        onClick={onCreate}
        className={cn(
          rigidClass(),
          "size-5 rounded-md text-faint-foreground transition-opacity duration-150",
          "pointer-events-none opacity-0 group-hover/pager:pointer-events-auto group-hover/pager:opacity-100",
          "hover:bg-foreground/5 hover:text-foreground",
        )}
      >
        <Center className="size-full">
          <Icon icon={addIcon} className="size-3" />
        </Center>
      </button>
      <button
        type="button"
        title="Overview (F3)"
        aria-label="Overview"
        onClick={onOverview}
        className={cn(
          rigidClass(),
          "size-[34px] rounded-lg hover:bg-foreground/10",
        )}
      >
        <Center className="size-full">
          <Icon icon={overviewIcon} className="size-4" />
        </Center>
      </button>
    </div>
  );
}
