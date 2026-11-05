import { useLayoutEffect, useMemo, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  PaneBox,
  PaneLayoutContext,
  type MatchEntry,
} from "@plugins/primitives/plugins/pane/web";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { useColumnCollapse } from "../hooks/use-column-collapse";
import {
  useClearMaximize,
  useColumnMaximize,
  useMaximizedId,
} from "../hooks/use-column-maximize";
import { useColumnWidth, useHasStoredWidth } from "../hooks/use-column-widths";
import { CollapsedBar } from "./collapsed-bar";
import { ResizeHandle } from "./resize-handle";

const DEFAULT_WIDTH = 400;

interface ColumnProps {
  entry: MatchEntry;
  isFirst: boolean;
  isLast: boolean;
  dragHandleProps?: Record<string, unknown>;
}

export function Column({
  entry,
  isFirst,
  isLast,
  dragHandleProps,
}: ColumnProps) {
  const [collapsed, toggleCollapse] = useColumnCollapse(entry.uuid);
  const [isMaximized, toggleMaximize] = useColumnMaximize(entry.uuid);
  const maximizedId = useMaximizedId();
  const clearMaximize = useClearMaximize();
  const tabId = useSurfaceTabId();
  const [width, setWidth] = useColumnWidth(
    entry.pane.id,
    entry.pane.width ?? DEFAULT_WIDTH,
  );

  // `HTMLElement`, not `HTMLDivElement`: `PaneBox` publishes its box as the
  // generic element (the tag is the theme boundary's to pick), and `offsetWidth`
  // is all this measurement needs.
  const divRef = useRef<HTMLElement>(null);
  // Tracks the actual rendered width while this column has flex-1 (isLast=true).
  const capturedWidthRef = useRef(0);

  // Keep capturedWidthRef up-to-date on every render while we're the last column.
  // No deps intentional: we need the latest measurement before the next column opens.
  useLayoutEffect(() => {
    if (isLast && divRef.current) {
      capturedWidthRef.current = divRef.current.offsetWidth;
    }
  });

  const setWidthRef = useLatestRef(setWidth);
  const hasStoredWidth = useHasStoredWidth();
  const paneId = entry.pane.id;

  useLayoutEffect(() => {
    if (
      !isLast &&
      capturedWidthRef.current > 0 &&
      !hasStoredWidth(tabId, paneId)
    ) {
      // First time a column opens to our right and the user hasn't set a custom
      // width: split the space 50/50 so both columns start roughly equal.
      setWidthRef.current(Math.round(capturedWidthRef.current / 2));
    }
  }, [isLast, paneId, tabId, hasStoredWidth]);

  const paneLayout = useMemo(
    () => ({
      onDoubleClickHeader: toggleMaximize,
      dragHandleProps,
      atSurfaceStart: isFirst,
      atSurfaceEnd: isLast || isMaximized,
    }),
    [toggleMaximize, dragHandleProps, isFirst, isLast, isMaximized],
  );

  // Some other column in THIS surface is maximized → collapse this one
  // (overrides isLast guard).
  const forcedCollapse = !isMaximized && maximizedId !== null;
  if (forcedCollapse) {
    return <CollapsedBar entry={entry} onExpand={clearMaximize} />;
  }

  const isCollapsed = collapsed && !isLast;
  const keepMounted = entry.pane.chrome.keepMountedWhenCollapsed;

  if (isCollapsed && !keepMounted) {
    return <CollapsedBar entry={entry} onExpand={toggleCollapse} />;
  }

  // Maximized column fills all available space regardless of its position.
  const expandFull = isLast || isMaximized;

  // When keepMounted is true and the column is collapsed, the body div stays
  // mounted at tree position 0 (hidden via display:none) so the component
  // subtree is never torn down. The CollapsedBar takes position 1.
  return (
    <>
      {/* `PaneBox` is the pane's own box: it stamps the pane id and the home
          app's theme scope on this element AND forwards both across portals, so
          popovers opened from this column still report their containing pane and
          keep its theme. This renderer owns only where the box sits and how wide
          it is. `PaneLayoutContext` wraps from outside — it is React context, so
          it reaches the pane regardless of which element it hangs off. */}
      <PaneLayoutContext.Provider value={paneLayout}>
        <PaneBox
          ref={divRef}
          pane={entry.pane}
          params={entry.params}
          style={
            isCollapsed
              ? { display: "none" }
              : expandFull
                ? undefined
                : { width }
          }
          // The column body is a flex-col clip pane whose row-child role is
          // JS-measured: the leaf column flex-grows (`flex-1`) while fixed-width
          // columns stay rigid (`shrink-0`), and `capturedWidthRef` reads
          // `offsetWidth` to split space 50/50 when a new column opens. The
          // flex-grow/shrink choice is computed per render, so it stays raw.
          // eslint-disable-next-line layout/no-adhoc-layout -- JS-measured flex-grow/shrink column body in miller's row
          className={
            isCollapsed
              ? undefined
              : expandFull
                ? "flex h-full min-w-[200px] flex-1 flex-col overflow-hidden"
                : "flex h-full shrink-0 flex-col overflow-hidden"
          }
        />
      </PaneLayoutContext.Provider>
      {isCollapsed ? (
        <CollapsedBar entry={entry} onExpand={toggleCollapse} />
      ) : (
        !isLast &&
        !isMaximized && (
          <ResizeHandle
            onResize={(dx) => setWidth((w) => w + dx)}
            onCollapse={toggleCollapse}
          />
        )
      )}
    </>
  );
}
