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
  /** A zoom is on in this row: a bar keeps its pane mounted under it. */
  zoomActive: boolean;
  onToggleZoom: (id: string) => void;
  onBarClick: () => void;
  onCollapse: () => void;
  onResizeStart: () => void;
  onResize: (dx: number) => void;
  onResizeEnd: (dx: number) => void;
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
  zoomActive,
  onToggleZoom,
  onBarClick,
  onCollapse,
  onResizeStart,
  onResize,
  onResizeEnd,
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

  // Under a zoom's bar the pane stays mounted and laid out at its unzoomed
  // width, hidden: leaving the zoom (or moving it here) then only uncovers
  // it, where unmounting would remount it — a long task in the very commit
  // that starts the motion, eating the transition — and lose its state.
  // A user-collapsed bar unmounts its pane unless the pane asks otherwise.
  const keepMounted = zoomActive || entry.pane.chrome.keepMountedWhenCollapsed;

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
        {/* Kept mounted under a bar, the pane sits past the bar (which fills
            the clip), its contents skipped, at the same child position, so its
            subtree is never torn down. */}
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
              // Under a bar: `content-visibility: hidden` — its contents
              // skip rendering, focus and hit-testing but keep their layout
              // state, so uncovering costs ~1ms. `visibility: hidden` would
              // restyle every descendant both ways (~100ms for a
              // conversation, measured), a long task in the very frame the
              // motion starts.
              style={
                box.bar
                  ? { width: inner, contentVisibility: "hidden" }
                  : { width: inner }
              }
              // A rigid flex-col clip pane at the pixel width the layout gives
              // it (wider than the box while it narrows).
              // eslint-disable-next-line layout/no-adhoc-layout -- JS-sized rigid pane body inside miller's column clip
              className="flex h-full shrink-0 flex-col overflow-hidden"
            />
          </PaneLayoutContext.Provider>
        )}
      </div>
      {box.handle && (
        <ResizeHandle
          onResizeStart={onResizeStart}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          onCollapse={onCollapse}
        />
      )}
    </div>
  );
}
