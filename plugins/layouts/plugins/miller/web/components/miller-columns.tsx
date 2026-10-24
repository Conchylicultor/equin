import { useCallback, useContext, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "@plugins/primitives/plugins/collapsible/web";
import { DeferredRouteFallback } from "@plugins/layouts/plugins/route-fallback/web";
import { scrollChildIntoView } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import {
  PaneBasePathContext,
  PaneInstanceContext,
  paneOwnerFor,
  usePaneMatch,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { UiRegion } from "@plugins/primitives/plugins/ui-context/web";
import {
  SortableItem,
  SortableList,
} from "@plugins/primitives/plugins/sortable-list/web";
import { Column } from "./column";
import { COLUMN_ATTR, ColumnMotion } from "./column-motion";

export function MillerColumns() {
  // Label only — the match itself comes from the surface.
  const basePath = useContext(PaneBasePathContext);
  const store = usePaneStore();
  const match = usePaneMatch();

  const ref = useRef<HTMLDivElement>(null);
  const lastLength = useRef(0);
  useLayoutEffect(() => {
    const len = match?.panes.length ?? 0;
    if (ref.current && len > lastLength.current) {
      // Bring the newest (rightmost) column into view by scrolling only this
      // horizontal container to align its end — a container-scoped scroll that
      // never touches any ancestor's scroll position. Omitting `block` leaves
      // the vertical offset untouched.
      scrollChildIntoView(
        ref.current,
        ref.current.lastElementChild as HTMLElement | null,
        {
          inline: "end",
          // Glides in step with the newcomer's entrance (ColumnMotion), which
          // glides back as a column leaves; the first paint lands in place.
          behavior:
            lastLength.current === 0 || prefersReducedMotion()
              ? "auto"
              : "smooth",
        },
      );
    }
    lastLength.current = len;
  }, [match?.panes.length]);

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

  return (
    <PluginErrorBoundary slot="layouts.miller" label={basePath}>
      {/* The horizontal flex row IS the x-scroll container: the SortableItem
          columns are its direct flex children, and the growth effect reveals
          this element's `lastElementChild` (the newest column) into view.
          `relative`: a closing column's ghost (ColumnMotion) is drawn
          absolutely over its last rect, in this row's scroll coordinates.
          flex-row + scroll-container can't be split without breaking the
          direct-child flex relationship dnd-kit relies on. */}
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
              return (
                <SortableItem
                  key={entry.instanceId}
                  id={String(entry.instanceId)}
                  handle
                  disabled={!canReorder}
                  wrapperProps={{ [COLUMN_ATTR]: entry.uuid }}
                  // The leaf column flex-grows to fill remaining width; fixed-width
                  // columns stay rigid. The grow/shrink choice is per-column state,
                  // so it stays raw.
                  // eslint-disable-next-line layout/no-adhoc-layout -- per-column flex-grow/shrink role in miller's row
                  className={(state) =>
                    `flex h-full${isLast ? " min-w-[200px] flex-1" : " shrink-0"}${state.isDragging ? " opacity-50" : ""}`
                  }
                >
                  {(state) => (
                    <PaneInstanceContext.Provider value={entry.instanceId}>
                      {/* The column as a named lineage region, so a picked element
                        reports the pane that contains it AND the plugin that
                        owns it. Wrapped HERE rather than inside `Column`: the
                        region then covers the column body, its CollapsedBar and
                        its ResizeHandle uniformly (Column has three early-return
                        shapes), and Column needs no new props. `label` carries
                        the position — miller panes are SIBLINGS, so an upward
                        walk from column 3 can never infer "3 of 3"; only the map
                        site knows it. */}
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
                            isFirst={i === 0}
                            isLast={isLast}
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
