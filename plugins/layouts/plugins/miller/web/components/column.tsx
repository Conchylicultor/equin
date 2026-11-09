import { useLayoutEffect, useMemo, useRef } from "react";
import {
  PaneBox,
  PaneLayoutContext,
  type MatchEntry,
} from "@plugins/primitives/plugins/pane/web";
import {
  MOTION_EASING_CSS,
  MOTION_MS,
  UNFOLD_FADE_MS,
  type ColumnBox,
} from "../layout";
import { CollapsedBar } from "./collapsed-bar";
import { ResizeHandle } from "./resize-handle";

interface ColumnProps {
  entry: MatchEntry;
  /** What the row's layout decided for this column. */
  box: ColumnBox;
  /** The pane's width inside the box — `box.inner`, or the wider width it
   *  had while the box narrows (clipped until the motion ends). */
  inner: number;
  /** A motion is running: the box's width transitions. */
  moving: boolean;
  /** This motion turned the column into a bar, or back into its pane. */
  fadeIn: "bar" | "pane" | null;
  isFirst: boolean;
  isLast: boolean;
  zoomed: boolean;
  onToggleZoom: (id: string) => void;
  onBarClick: () => void;
  onCollapse: () => void;
  onResize: (dx: number) => void;
  dragHandleProps?: Record<string, unknown>;
}

/**
 * One column: ONE box whose width is the layout's, holding either the pane or
 * its collapsed bar. Collapsing, expanding and zooming change only what the box
 * holds and how wide it is — so a bar growing back into its pane is this box's
 * width animating 32 → full, never a second element arriving.
 */
export function Column({
  entry,
  box,
  inner,
  moving,
  fadeIn,
  isFirst,
  isLast,
  zoomed,
  onToggleZoom,
  onBarClick,
  onCollapse,
  onResize,
  dragHandleProps,
}: ColumnProps) {
  const id = entry.uuid;
  const paneLayout = useMemo(
    () => ({
      onDoubleClickHeader: () => onToggleZoom(id),
      dragHandleProps,
      atSurfaceStart: isFirst,
      atSurfaceEnd: isLast || zoomed,
    }),
    [onToggleZoom, id, dragHandleProps, isFirst, isLast, zoomed],
  );

  // A pane coming back from its bar fades in as its box grows around it.
  const paneRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (fadeIn !== "pane") return;
    paneRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: UNFOLD_FADE_MS,
      easing: "ease-out",
    });
  }, [fadeIn]);

  const keepMounted = entry.pane.chrome.keepMountedWhenCollapsed;

  return (
    // The column box: its width is the layout's, transitioned while a motion
    // runs (a drag or a row resize follows at once). The pane inside keeps its
    // own pixel width, so a narrowing box clips it rather than re-wrapping it
    // every frame; the divider sits on the box's right edge, inside its width.
    <div
      // eslint-disable-next-line layout/no-adhoc-layout -- JS-sized rigid column box in miller's row (width from the row layout)
      className="relative flex h-full shrink-0"
      style={{
        width: box.width,
        transition: moving
          ? `width ${MOTION_MS}ms ${MOTION_EASING_CSS}`
          : undefined,
      }}
    >
      {/* The clip: what the box does not show of its content. */}
      {/* eslint-disable-next-line layout/no-adhoc-layout -- clip region filling the column box beside its divider */}
      <div className="flex h-full min-w-0 flex-1 overflow-hidden">
        {box.bar && (
          <CollapsedBar
            entry={entry}
            onExpand={onBarClick}
            fadeIn={fadeIn === "bar"}
          />
        )}
        {/* With keepMounted the pane stays mounted (hidden) while collapsed, at
            the same child position, so its subtree is never torn down. */}
        {(!box.bar || keepMounted) && (
          // `PaneBox` is the pane's own box: it stamps the pane id and the home
          // app's theme scope on this element AND forwards both across portals,
          // so popovers opened from this column still report their containing
          // pane and keep its theme. This renderer owns only its width.
          // `PaneLayoutContext` wraps from outside — it is React context, so it
          // reaches the pane regardless of which element it hangs off.
          <PaneLayoutContext.Provider value={paneLayout}>
            <PaneBox
              ref={paneRef}
              pane={entry.pane}
              params={entry.params}
              style={box.bar ? { display: "none" } : { width: inner }}
              // A rigid flex-col clip pane at the pixel width the layout gives
              // it (wider than the box while it narrows).
              // eslint-disable-next-line layout/no-adhoc-layout -- JS-sized rigid pane body inside miller's column clip
              className="flex h-full shrink-0 flex-col overflow-hidden"
            />
          </PaneLayoutContext.Provider>
        )}
      </div>
      {box.handle && (
        <ResizeHandle onResize={onResize} onCollapse={onCollapse} />
      )}
    </div>
  );
}
