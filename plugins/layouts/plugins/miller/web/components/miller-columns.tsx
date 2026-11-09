import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { prefersReducedMotion } from "@plugins/primitives/plugins/css/plugins/motion/web";
import { DeferredRouteFallback } from "@plugins/layouts/plugins/route-fallback/web";
import {
  glideScroll,
  restoreScrollOffset,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import {
  PaneBasePathContext,
  PaneInstanceContext,
  paneOwnerFor,
  usePaneMatch,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { UiRegion } from "@plugins/primitives/plugins/ui-context/web";
import {
  SortableItem,
  SortableList,
} from "@plugins/primitives/plugins/sortable-list/web";
import { useCollapsedColumns } from "../hooks/use-column-collapse";
import { useColumnWidths } from "../hooks/use-column-widths";
import { useColumnZoom } from "../hooks/use-column-zoom";
import {
  DEFAULT_COLUMN_WIDTH,
  MOTION_EASING,
  MOTION_MS,
  effectiveZoom,
  heldInner,
  dragLayout,
  layoutColumns,
  moveZoom,
  routeKey,
  scrollTarget,
  toggleZoom,
  type ColumnBox,
  type RowLayout,
  type ZoomState,
} from "../layout";
import { Column } from "./column";
import { COLUMN_ATTR, ColumnMotion } from "./column-motion";

/** What the row looked like at the last commit — the "before" of a motion. */
interface Previous {
  key: string;
  route: string;
  /** The zoom in effect then (its state), for restoring the row on leaving it. */
  zoom: ZoomState | null;
  layout: RowLayout;
  rowWidth: number;
  /** The row's end offset when we last put the row at its end (null when we
   *  put it elsewhere — a zoom restored to the scroll from before it). */
  pinned: number | null;
}

/** A divider drag in progress: the row as it was when it began. */
interface Drag {
  id: string;
  start: RowLayout;
  /** The dragged column's displayed width when the drag began. */
  startWidth: number;
  /** How far the pointer has moved since. */
  dx: number;
}

/** The columns' widths before the motion `key`, held while it runs. */
interface Hold {
  key: string;
  before: ReadonlyMap<string, ColumnBox>;
}

export function MillerColumns() {
  // Label only — the match itself comes from the surface.
  const basePath = useContext(PaneBasePathContext);
  const store = usePaneStore();
  const match = usePaneMatch();
  const widths = useColumnWidths();
  const collapsed = useCollapsedColumns();
  const [zoomState, setZoom] = useColumnZoom();

  const ref = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useResizeObserver(
    ref,
    () => {
      if (ref.current) setRowWidth(ref.current.clientWidth);
    },
    // Measured before paint: the row's width decides the leaf's fill.
    { beforePaint: true, deps: [match !== null] },
  );

  const panes = useMemo(() => match?.panes ?? [], [match]);
  const ids = useMemo(() => panes.map((e) => e.uuid), [panes]);
  const route = routeKey(ids);
  const zoomed = effectiveZoom(zoomState, route, ids);
  const fitted = useMemo(
    () =>
      layoutColumns(
        panes.map((e) => {
          const own = widths.stored(e.pane.id);
          return {
            id: e.uuid,
            width: own ?? e.pane.width ?? DEFAULT_COLUMN_WIDTH,
            collapsed: collapsed.isCollapsed(e.uuid),
            fixed: own !== null,
          };
        }),
        rowWidth,
        zoomed,
      ),
    [panes, widths, collapsed, rowWidth, zoomed],
  );
  // A divider drag lays the row out as it was when the drag began, the
  // dragged column following the pointer (`dragLayout`); the fit applies
  // again when it ends.
  const [drag, setDrag] = useState<Drag | null>(null);
  const [releases, setReleases] = useState(0);
  // The drag as the pointer handlers last left it (they outlive renders).
  const dragRef = useRef<Drag | null>(null);
  const setDragBoth = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const layout = useMemo(
    () =>
      drag === null
        ? fitted
        : dragLayout(drag.start, drag.id, drag.startWidth + drag.dx, rowWidth),
    [drag, fitted, rowWidth],
  );

  // A motion is a change of what the row shows — its route, the zoom, which
  // columns are bars — and the re-fit at the end of a drag. The drag itself
  // and a row resize are none: they follow at once, never animated.
  const motionKey = `${route}#${zoomed ?? ""}#${layout.columns
    .filter((c) => c.bar)
    .map((c) => c.id)
    .join(",")}#${releases}`;
  const [settledKey, setSettledKey] = useState(motionKey);
  const [hold, setHold] = useState<Hold | null>(null);
  const moving = motionKey !== settledKey && !prefersReducedMotion();

  const prev = useRef<Previous | null>(null);
  const stopGlide = useRef<(() => void) | null>(null);
  const settleFrame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const before = prev.current;
    const end = scrollTarget(layout, row.clientWidth);
    const next: Previous = {
      key: motionKey,
      route,
      zoom: zoomed !== null ? zoomState : null,
      layout,
      rowWidth,
      pinned: before?.pinned ?? null,
    };
    prev.current = next;
    // The first row lands in place: its end on screen, nothing animated.
    if (!before) {
      restoreScrollOffset(row, { left: end });
      next.pinned = end;
      setSettledKey(motionKey);
      return;
    }
    // A zoom made on another route is already inert (`effectiveZoom`); drop
    // it, so going back to that route (back/forward restores its instances)
    // does not zoom again.
    if (zoomState !== null && zoomState.route !== route) setZoom(null);
    if (before.key === motionKey) {
      // The row resized (the window, a sidebar arriving after boot) while it
      // sat at its end: it stays at its end. A divider drag changes no row
      // width, so it never moves the row under the pointer.
      if (
        before.rowWidth !== rowWidth &&
        before.pinned !== null &&
        Math.abs(row.scrollLeft - before.pinned) <= 1
      ) {
        restoreScrollOffset(row, { left: end });
        next.pinned = end;
      }
      return;
    }
    // Leaving a zoom with the route unchanged puts the row back where it was;
    // anything else reveals the newest column.
    const restore =
      before.zoom !== null && zoomed === null && before.route === route
        ? before.zoom.scrollFrom
        : undefined;
    const target = scrollTarget(layout, row.clientWidth, restore);
    next.pinned = target === end ? end : null;
    stopGlide.current?.();
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    if (prefersReducedMotion() || before.route === "") {
      restoreScrollOffset(row, { left: target });
      setSettledKey(motionKey);
      return;
    }
    setHold({
      key: motionKey,
      before: new Map(before.layout.columns.map((c) => [c.id, c])),
    });
    // On the next frame the boxes' width transitions exist: the scroll glides
    // on the clock of one of them (same curve, same duration), so the widths
    // and the scroll are one motion even when a long task delays or eats the
    // transition's start; and when they have all run, the transition style
    // and the held widths are dropped. Both read off the transitions
    // themselves, never a timer started now.
    settleFrame.current = requestAnimationFrame(() => {
      settleFrame.current = null;
      const transitions = row
        .getAnimations({ subtree: true })
        .filter(
          (a) => a instanceof CSSTransition && a.transitionProperty === "width",
        );
      stopGlide.current = glideScroll(
        row,
        { left: target },
        {
          duration: MOTION_MS,
          easing: MOTION_EASING,
          ...(transitions[0] ? { follow: transitions[0] } : {}),
        },
      );
      void Promise.allSettled(transitions.map((a) => a.finished)).then(() => {
        // A later motion owns the row now; it settles itself.
        if (prev.current?.key === motionKey) setSettledKey(motionKey);
      });
    });
  }, [motionKey, route, zoomed, zoomState, setZoom, layout, rowWidth]);

  useEffect(
    () => () => {
      stopGlide.current?.();
      if (settleFrame.current !== null)
        cancelAnimationFrame(settleFrame.current);
    },
    [],
  );

  const startDrag = (id: string, startWidth: number) =>
    setDragBoth({ id, start: layout, startWidth, dx: 0 });
  const moveDrag = (dx: number) => {
    const d = dragRef.current;
    if (d) setDragBoth({ ...d, dx });
  };
  const endDrag = (paneId: string, dx: number) => {
    const d = dragRef.current;
    setDragBoth(null);
    if (!d || dx === 0) return;
    // The column's own width becomes what the drag left on screen; dragged,
    // the fit no longer compresses it. The re-fit that follows is a motion.
    widths.setWidth(paneId, d.startWidth + dx);
    setReleases((n) => n + 1);
  };

  const onToggleZoom = useCallback(
    (id: string) =>
      setZoom(
        toggleZoom(zoomState, id, route, ids, ref.current?.scrollLeft ?? 0),
      ),
    [setZoom, zoomState, route, ids],
  );

  // Esc leaves a zoom — registered only while one is on, so the key is free
  // otherwise (solo's Esc, a dialog's).
  const shortcuts = useMemo(
    () =>
      zoomed === null
        ? []
        : [
            {
              id: "miller.leave-zoom",
              keys: "Escape",
              label: "Leave zoomed column",
              precedence: 5,
              // Also from a text field: a pane focuses its composer on mount
              // (a conversation), which would otherwise swallow the key for
              // as long as the zoom lasts. A field that handles Esc itself
              // (preventDefault) still keeps it.
              enableInInputs: true,
              handler: () => setZoom(null),
            },
          ],
    [zoomed, setZoom],
  );
  useSurfaceShortcuts(shortcuts);

  const handleMove = useCallback(
    (activeId: string, overId: string) => {
      const chain = store.getRoute();
      const fromIdx = chain.findIndex((s) => String(s.instanceId) === activeId);
      const toIdx = chain.findIndex((s) => String(s.instanceId) === overId);
      if (fromIdx >= 0 && toIdx >= 0) {
        store.reorderRoute(fromIdx, toIdx);
      }
    },
    [store],
  );

  // No matched route. During the post-paint deferred-load gap the pane the URL
  // points at may not be registered yet, so show a loading placeholder while
  // deferred loading is in progress; once it settles this falls back to null
  // (genuinely-invalid URL). See route-fallback for the full rationale.
  if (!match) return <DeferredRouteFallback />;

  const itemIds = match.panes.map((e) => String(e.instanceId));
  // Reordering only makes sense with 2+ columns. With a single pane there is
  // nowhere to drag it, so suppress the drag handle (and its grab cursor).
  const canReorder = match.panes.length > 1;
  const held = moving && hold?.key === motionKey ? hold.before : null;

  return (
    <PluginErrorBoundary slot="layouts.miller" label={basePath}>
      {/* The horizontal flex row IS the x-scroll container: the SortableItem
          columns are its direct flex children, each as wide as its column box
          (the layout above decides every width; the row scrolls when they
          overflow it). `relative`: a closing column's ghost (ColumnMotion) is
          drawn absolutely over its last rect, in this row's scroll
          coordinates. flex-row + scroll-container can't be split without
          breaking the direct-child flex relationship dnd-kit relies on. */}
      {/* eslint-disable-next-line layout/no-adhoc-layout -- flex-row x-scroll container holding the sortable columns as direct children */}
      <div ref={ref} className="relative flex h-full overflow-x-auto">
        <ColumnMotion rowRef={ref} panes={match.panes}>
          <SortableList
            items={itemIds}
            onMove={handleMove}
            orientation="horizontal"
          >
            {match.panes.map((entry, i) => {
              const isLast = i === match.panes.length - 1;
              const box = layout.columns[i]!;
              const before = held?.get(entry.uuid);
              const fadeIn =
                before === undefined || before.bar === box.bar
                  ? null
                  : box.bar
                    ? "bar"
                    : "pane";
              return (
                <SortableItem
                  key={entry.instanceId}
                  id={String(entry.instanceId)}
                  handle
                  disabled={!canReorder}
                  wrapperProps={{ [COLUMN_ATTR]: entry.uuid }}
                  // A rigid flex child as wide as its column box (Column sets
                  // the width). Drag state dims it, so it stays raw.
                  // eslint-disable-next-line layout/no-adhoc-layout -- rigid column wrapper in miller's row, sized by its column box
                  className={(state) =>
                    `flex h-full shrink-0${state.isDragging ? " opacity-50" : ""}`
                  }
                >
                  {(state) => (
                    <PaneInstanceContext.Provider value={entry.instanceId}>
                      {/* The column as a named lineage region, so a picked element
                        reports the pane that contains it AND the plugin that
                        owns it. Wrapped HERE rather than inside `Column`: the
                        region then covers the column body, its CollapsedBar and
                        its ResizeHandle uniformly, and Column needs no lineage
                        props. `label` carries the position — miller panes are
                        SIBLINGS, so an upward walk from column 3 can never infer
                        "3 of 3"; only the map site knows it. */}
                      <UiRegion
                        kind="pane"
                        id={entry.pane.id}
                        label={`column ${i + 1} of ${match.panes.length}`}
                        pluginId={paneOwnerFor(entry.pane)}
                      >
                        {/* Per-column boundary: a crash inside one pane is
                          contained to that column; sibling panes survive.
                          The outer boundary remains as a backstop for the
                          row scaffolding (SortableList, drag). */}
                        <PluginErrorBoundary
                          slot="layouts.miller"
                          label={entry.pane.id}
                        >
                          <Column
                            entry={entry}
                            box={box}
                            inner={moving ? heldInner(box, before) : box.inner}
                            moving={moving}
                            fadeIn={fadeIn}
                            isFirst={i === 0}
                            isLast={isLast}
                            zoomed={zoomed === entry.uuid}
                            zoomActive={zoomed !== null}
                            onToggleZoom={onToggleZoom}
                            onBarClick={() =>
                              zoomed !== null
                                ? setZoom(
                                    moveZoom(zoomState, entry.uuid, route, ids),
                                  )
                                : collapsed.toggle(entry.uuid)
                            }
                            onCollapse={() => collapsed.toggle(entry.uuid)}
                            onResizeStart={() =>
                              startDrag(entry.uuid, box.width)
                            }
                            onResize={moveDrag}
                            onResizeEnd={(dx) => endDrag(entry.pane.id, dx)}
                            dragHandleProps={
                              canReorder ? state.handleProps : undefined
                            }
                          />
                        </PluginErrorBoundary>
                      </UiRegion>
                    </PaneInstanceContext.Provider>
                  )}
                </SortableItem>
              );
            })}
          </SortableList>
        </ColumnMotion>
      </div>
    </PluginErrorBoundary>
  );
}
