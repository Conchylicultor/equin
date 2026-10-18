import { useMemo, useRef, useSyncExternalStore, type DragEvent } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { SpringOpen } from "@plugins/primitives/plugins/tree/web";
import type {
  ManualOrderConfig,
  RowDragConfig,
  RowDropContext,
  RowDropEdge,
  ViewRowDropConfig,
} from "../../core";

/** Where the drag is right now, inside one view: at an accepting row (into
 *  it, or the gap before / after it), over the empty space of a section (its
 *  group), or over nothing of ours. */
type DropOver =
  | { kind: "row"; key: string; edge: RowDropEdge }
  | { kind: "background"; group: string | null }
  | null;

interface DropOverStore {
  get: () => DropOver;
  set: (next: DropOver) => void;
  subscribe: (listener: () => void) => () => void;
}

function createDropOverStore(): DropOverStore {
  let over: DropOver = null;
  const listeners = new Set<() => void>();
  return {
    get: () => over,
    set: (next) => {
      if (sameOver(over, next)) return;
      over = next;
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function sameOver(a: DropOver, b: DropOver): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "row")
    return b.kind === "row" && a.key === b.key && a.edge === b.edge;
  return b.kind === "background" && a.group === b.group;
}

/** The handlers that make an element a native drop target. */
export interface DropTargetProps {
  /** The same handler as `onDragOver`: a drag that enters and rests sends
   *  `dragenter` and, in some drivers, no `dragover` until it moves. */
  onDragEnter: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

/** A row's native drag-source and drop-target props (each half present when
 *  the view has `rowDrag` / `rowDrop`). Spread onto the ONE row element. */
export type RowDndProps = Partial<DropTargetProps> & {
  draggable?: true;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLElement>) => void;
};

/** A hierarchical view's rows, by key: a drop over a row that does not take
 *  it goes up to the nearest one that does. */
export interface RowDndHierarchy<TRow> {
  /** The row's parent key; `null` for a root. */
  parentOf: (key: string) => string | null;
  rowOf: (key: string) => TRow | undefined;
}

/** A `"between"` view's rows as painted, by key — what gives a gap its one
 *  spelling: the gap above a row is the one after the row above it. */
export interface RowDndSequence<TRow> {
  /** The row painted just above `key` in its section; `null` for a
   *  section's first row. */
  above: (key: string) => string | null;
  rowOf: (key: string) => TRow | undefined;
}

/**
 * One view's native row drag and drop (`rowDrag` / `rowDrop`): the handlers
 * its rows and its empty space spread, and where the drag is (read per row by
 * {@link useRowDropState}, so a moving drag re-renders the rows it leaves and
 * enters, never the list). Stable identity for the view's life.
 */
export interface RowDnd<TRow> {
  rowProps: (key: string, row: TRow) => RowDndProps;
  /** The empty space of a section (`group`; `null` ungrouped) whose last
   *  painted row is `lastKey` (`null` when it has none) — where a
   *  `"between"` drop there is inserted. `undefined` when the view takes no
   *  drop there. */
  backgroundProps: (
    group: string | null,
    lastKey: string | null,
  ) => DropTargetProps | undefined;
  /** Into rows, or between them (`rowDrop.placement`). */
  placement: "into" | "between";
  store: DropOverStore;
  /** Is `key` strictly inside `ancestor` (always `false` without a hierarchy)? */
  isWithin: (key: string, ancestor: string) => boolean;
}

/** The highlight of an accepting drop target (the drop-into ring a tree row
 *  shows under a drag). */
export const DROP_TARGET_RING = "ring-1 ring-primary/40";

/** The wash over the rows inside a folder a drop goes into, so the whole
 *  folder reads as the target, not just its row. */
export const DROP_TARGET_WASH = "bg-primary/5";

/** Which half of the row the pointer is in, under `"between"` — the gap
 *  above or below it, before {@link RowDnd}'s resolver gives it its one
 *  spelling. */
function edgeAt(e: DragEvent<HTMLElement>): "before" | "after" {
  const box = e.currentTarget.getBoundingClientRect();
  return e.clientY < box.top + box.height / 2 ? "before" : "after";
}

const NO_ORDER: RowDropContext = { order: null };

/**
 * The drop's {@link RowDropContext}: the view's manual order at the gap
 * `edge` of `targetKey`, when the view renders in one that can place rows.
 */
function dropContext(
  order: ManualOrderConfig<unknown> | undefined,
  targetKey: string | null,
  edge: RowDropEdge,
): RowDropContext {
  const onInsert = order?.onInsert;
  if (!onInsert || targetKey === null || edge === "into") return NO_ORDER;
  return {
    order: {
      insert: (keys) => onInsert(keys, { targetId: targetKey, zone: edge }),
    },
  };
}

/** Who set the current drop target — only its own leave clears it (the next
 *  target's enter comes before). */
const rowSetter = (key: string) => `row:${key}`;
const backgroundSetter = (group: string | null) =>
  `background:${JSON.stringify(group)}`;

/** The resolved target of a drag over one row. */
type RowTarget =
  | { kind: "row"; key: string; row: unknown; edge: RowDropEdge }
  | { kind: "background" }
  | { kind: "none" };

/**
 * The view's native row drag and drop, or `null` when it has neither
 * `rowDrag` nor `rowDrop`.
 *
 * - **Drag.** The grabbed row carries `dragRows(key)` (the selection when the
 *   row is in it); `rowDrag.write` puts them on the `DataTransfer`, and more
 *   than one draws an "N items" drag image.
 * - **Drop on a row.** An accepting row (`rowDrop.accepts`) takes the drop and
 *   stops it there — into it, or under `"between"` at the gap of its nearer
 *   half — ONE gap between two rows, spelled `"after"` the upper one (from
 *   `sequence`), so the pointer crossing from one row into the other moves
 *   neither the target nor the line. With `hierarchy`, a row that does not accept hands it to its nearest
 *   accepting ancestor, a root's to the empty space. Without, any other row
 *   lets it fall through to the empty space, and with nothing accepting the
 *   cursor says no-drop (`dropEffect: "none"`).
 * - **Own rows.** A drag of this view's rows is no drop over or inside a
 *   dragged row, nor (with `hierarchy`) onto the parent already holding all
 *   of them: dropped there, the drag cancels.
 * - **Spring.** With `spring`, an accepting row's hover feeds the tree's
 *   spring-open timer, and every drop ends it.
 */
export function useRowDnd<TRow>(args: {
  rowDrag: RowDragConfig<TRow> | undefined;
  rowDrop: ViewRowDropConfig<TRow> | undefined;
  dragRows: (key: string) => readonly { key: string; row: TRow }[];
  hierarchy?: RowDndHierarchy<TRow>;
  /** The rows as painted — required under `placement: "between"`. */
  sequence?: RowDndSequence<TRow>;
  spring?: { open: SpringOpen; springable: (key: string) => boolean };
  /** The view's ACTIVE manual order (`DataViewRenderProps.manualOrder`:
   *  absent while a sort overrides it) — a `"between"` drop's
   *  `RowDropContext.order` inserts into it. */
  order?: ManualOrderConfig<TRow>;
}): RowDnd<TRow> | null {
  const latest = useLatestRef(args);
  // The keys THIS view is dragging: none of them may take its own drop.
  const dragging = useRef<ReadonlySet<string>>(new Set());
  // Who set the target (`rowSetter` / `backgroundSetter`; a row's may name
  // an ancestor or the gap above it): only its own leave clears it.
  const hoveredBy = useRef<string | null>(null);
  const hasDrag = args.rowDrag !== undefined;
  const hasDrop = args.rowDrop !== undefined;
  const hasBackground = args.rowDrop?.background !== undefined;
  const placement = args.rowDrop?.placement ?? "into";
  if (placement === "between" && args.sequence === undefined) {
    throw new Error(
      'data-view useRowDnd: placement "between" needs `sequence` — a gap is spelled by the row painted above it',
    );
  }
  const dnd = useMemo<RowDnd<TRow>>(() => {
    const store = createDropOverStore();
    const effect = () => latest.current.rowDrop?.dropEffect ?? "move";
    const types = (e: DragEvent<HTMLElement>) =>
      Array.from(e.dataTransfer.types);
    const parentOf = (key: string) =>
      latest.current.hierarchy?.parentOf(key) ?? null;
    const isWithin = (key: string, ancestor: string) => {
      if (!latest.current.hierarchy) return false;
      for (let cur = parentOf(key); cur !== null; cur = parentOf(cur)) {
        if (cur === ancestor) return true;
      }
      return false;
    };
    // The parent already holding every dragged row (`null`: the roots), or
    // `undefined` when they have no one parent — or this view drags nothing.
    const draggedHome = (): string | null | undefined => {
      if (!latest.current.hierarchy || dragging.current.size === 0)
        return undefined;
      let home: string | null | undefined;
      for (const key of dragging.current) {
        const p = parentOf(key);
        if (home === undefined) home = p;
        else if (home !== p) return undefined;
      }
      return home;
    };

    // The gap at `edge` of `key`, in its one spelling: the gap above a row
    // that has a row above it is that row's `"after"`.
    const resolveGap = (
      key: string,
      row: TRow | undefined,
      edge: "before" | "after",
      t: readonly string[],
    ): RowTarget => {
      const { rowDrop, sequence } = latest.current;
      if (!rowDrop) return { kind: "none" };
      let at = key;
      let atRow = row;
      let side = edge;
      const above = edge === "before" ? (sequence?.above(key) ?? null) : null;
      if (above !== null) {
        at = above;
        atRow = sequence?.rowOf(above);
        side = "after";
      }
      if (
        atRow !== undefined &&
        !dragging.current.has(at) &&
        rowDrop.accepts(atRow, t, side)
      )
        return { kind: "row", key: at, row: atRow, edge: side };
      return { kind: "background" };
    };

    const resolveRow = (
      key: string,
      row: TRow,
      e: DragEvent<HTMLElement>,
    ): RowTarget => {
      const { rowDrop, hierarchy } = latest.current;
      if (!rowDrop) return { kind: "none" };
      const t = types(e);
      if (placement === "between") return resolveGap(key, row, edgeAt(e), t);
      if (!hierarchy) {
        if (!dragging.current.has(key) && rowDrop.accepts(row, t, "into"))
          return { kind: "row", key, row, edge: "into" };
        return { kind: "background" };
      }
      // Up from the row to the first that takes it; over or inside a dragged
      // row there is none.
      let target: RowTarget = { kind: "background" };
      for (let cur: string | null = key; cur !== null; cur = parentOf(cur)) {
        if (dragging.current.has(cur)) return { kind: "none" };
        if (target.kind === "background") {
          const r = cur === key ? row : hierarchy.rowOf(cur);
          if (r !== undefined && rowDrop.accepts(r, t, "into"))
            target = { kind: "row", key: cur, row: r, edge: "into" };
        }
      }
      const home = draggedHome();
      const at = target.kind === "row" ? target.key : null;
      if (home !== undefined && home === at) return { kind: "none" };
      return target;
    };

    const finish = (droppedOn: string | null) => {
      store.set(null);
      dragging.current = new Set();
      latest.current.spring?.open.end(droppedOn);
    };

    // The source's own end: whatever it was dragged onto, nothing of it is
    // in flight any more (a drop on another view never reaches `finish`).
    const finishDrag = () => {
      dragging.current = new Set();
      store.set(null);
    };

    // No drop here, and nothing under it may take one instead.
    const refuse = (e: DragEvent<HTMLElement>) => {
      e.stopPropagation();
      e.dataTransfer.dropEffect = "none";
      store.set(null);
      latest.current.spring?.open.hover(null, false);
    };

    // A drag over a row target (from a row, or a gap's trailing empty space).
    const overRow = (
      target: RowTarget & { kind: "row" },
      e: DragEvent<HTMLElement>,
      setter: string,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = effect();
      store.set({ kind: "row", key: target.key, edge: target.edge });
      hoveredBy.current = setter;
      const spring = latest.current.spring;
      spring?.open.hover(target.key, spring.springable(target.key));
    };

    const dropOnRow = (
      target: RowTarget & { kind: "row" },
      e: DragEvent<HTMLElement>,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      finish(target.key);
      const { rowDrop, order } = latest.current;
      if (rowDrop)
        void rowDrop.onDrop(
          target.row as TRow,
          e.dataTransfer,
          target.edge,
          dropContext(
            order as ManualOrderConfig<unknown> | undefined,
            target.key,
            target.edge,
          ),
        );
    };

    const rowProps = (key: string, row: TRow): RowDndProps => {
      const props: RowDndProps = {};
      if (hasDrag) {
        props.draggable = true;
        props.onDragStart = (e) => {
          const { rowDrag, dragRows } = latest.current;
          if (!rowDrag) return;
          const carried = dragRows(key);
          dragging.current = new Set(carried.map((c) => c.key));
          rowDrag.write(
            carried.map((c) => c.row),
            e.dataTransfer,
          );
          if (carried.length > 1)
            setCountDragImage(e.dataTransfer, carried.length);
        };
        props.onDragEnd = () => finishDrag();
      }
      if (hasDrop) {
        const onOver = (e: DragEvent<HTMLElement>) => {
          const target = resolveRow(key, row, e);
          if (target.kind === "none") return refuse(e);
          if (target.kind === "background") {
            // Fall through to the empty space, which decides; with none, the
            // cursor says no-drop here — unless a box around the view (a
            // pane) takes it as the drag bubbles on.
            latest.current.spring?.open.hover(null, false);
            if (!hasBackground) {
              e.dataTransfer.dropEffect = "none";
              store.set(null);
            }
            return;
          }
          overRow(target, e, rowSetter(key));
        };
        props.onDragEnter = onOver;
        props.onDragOver = onOver;
        props.onDragLeave = (e) => {
          if (leftFor(e)) return;
          if (hoveredBy.current === rowSetter(key)) store.set(null);
        };
        props.onDrop = (e) => {
          const target = resolveRow(key, row, e);
          if (target.kind === "row") dropOnRow(target, e);
        };
      }
      return props;
    };

    const backgroundProps = (
      group: string | null,
      lastKey: string | null,
    ): DropTargetProps | undefined => {
      if (!hasBackground) return undefined;
      const setter = backgroundSetter(group);
      // Under `"between"` the space after the rows is the last row's own
      // `"after"` gap — one target, one line — when that row takes it.
      const endGap = (e: DragEvent<HTMLElement>) => {
        if (placement !== "between" || lastKey === null) return null;
        const target = resolveGap(
          lastKey,
          latest.current.sequence?.rowOf(lastKey),
          "after",
          types(e),
        );
        return target.kind === "row" ? target : null;
      };
      // The roots' own parent is no drop for rows already there.
      const accepts = (e: DragEvent<HTMLElement>) =>
        draggedHome() !== null &&
        (latest.current.rowDrop?.background?.accepts(types(e), group) ?? false);
      const onOver = (e: DragEvent<HTMLElement>) => {
        const gap = endGap(e);
        if (gap) return overRow(gap, e, setter);
        latest.current.spring?.open.hover(null, false);
        if (!accepts(e)) {
          e.dataTransfer.dropEffect = "none";
          store.set(null);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = effect();
        store.set({ kind: "background", group });
        hoveredBy.current = setter;
      };
      return {
        onDragEnter: onOver,
        onDragOver: onOver,
        onDragLeave: (e) => {
          if (leftFor(e)) return;
          if (hoveredBy.current === setter) store.set(null);
        },
        onDrop: (e) => {
          const gap = endGap(e);
          if (gap) return dropOnRow(gap, e);
          if (!accepts(e)) return;
          e.preventDefault();
          finish(null);
          const { rowDrop, order } = latest.current;
          const background = rowDrop?.background;
          if (background)
            void background.onDrop(
              e.dataTransfer,
              group,
              placement === "between"
                ? dropContext(
                    order as ManualOrderConfig<unknown> | undefined,
                    lastKey,
                    "after",
                  )
                : NO_ORDER,
            );
        },
      };
    };

    return { rowProps, backgroundProps, placement, store, isWithin };
  }, [latest, hasDrag, hasDrop, hasBackground, placement]);
  return hasDrag || hasDrop ? dnd : null;
}

/** `dragleave` fires when the pointer moves onto a child of the same element
 *  (and bubbles up from a child it leaves); only a leave to OUTSIDE it is a
 *  leave. Chromium often hands a drag event no `relatedTarget`, so where it
 *  has none, what is under the pointer now says where it went. */
function leftFor(e: DragEvent<HTMLElement>): boolean {
  const to = e.relatedTarget ?? document.elementFromPoint(e.clientX, e.clientY);
  return to instanceof Node && e.currentTarget.contains(to);
}

const NO_STORE: DropOverStore = {
  get: () => null,
  set: () => undefined,
  subscribe: () => () => undefined,
};

/**
 * What a drag means for this row: it drops `"into"` it, in the gap
 * `"before"` / `"after"` it, or `"inside"` — the row is in the folder the
 * drop goes into. `null` when none.
 */
export function useRowDropState<TRow>(
  dnd: RowDnd<TRow> | null,
  key: string,
): RowDropEdge | "inside" | null {
  const store = dnd?.store ?? NO_STORE;
  return useSyncExternalStore(store.subscribe, () => {
    const over = store.get();
    if (over?.kind !== "row") return null;
    if (over.key === key) return over.edge;
    return over.edge === "into" && dnd?.isWithin(key, over.key)
      ? "inside"
      : null;
  });
}

/** Is the drag over this section's empty space, which accepts it? */
export function useIsBackgroundDropTarget<TRow>(
  dnd: RowDnd<TRow> | null,
  group: string | null,
): boolean {
  const store = dnd?.store ?? NO_STORE;
  return useSyncExternalStore(store.subscribe, () => {
    const over = store.get();
    return over?.kind === "background" && over.group === group;
  });
}

/**
 * Draw a multi-row drag as one "N items" chip rather than the grabbed row's
 * snapshot. The browser snapshots the element synchronously inside
 * `setDragImage`, so it lives only until the next task.
 */
function setCountDragImage(dt: DataTransfer, count: number): void {
  const chip = document.createElement("div");
  chip.textContent = `${count} items`;
  chip.className =
    "fixed -left-[9999px] top-0 rounded-md bg-popover px-sm py-xs text-body text-popover-foreground shadow";
  document.body.append(chip);
  dt.setDragImage(chip, 12, 12);
  setTimeout(() => chip.remove(), 0);
}
