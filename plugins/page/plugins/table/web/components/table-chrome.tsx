import { useRef, useState, type RefObject } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Placed,
  placedClasses,
  placedStyle,
  type Extent,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { RichTextFieldCaret } from "@plugins/page/plugins/editor/web";
import type { TableAlign, TableData } from "../../core";
import {
  clearColumn,
  clearRow,
  deleteColumn,
  deleteRow,
  duplicateColumn,
  duplicateRow,
  insertColumn,
  insertRow,
  movedTo,
  moveColumn,
  moveRow,
  resizeColumn,
  setAlign,
} from "../internal/table-ops";
import {
  gaps,
  nearestGap,
  type InsertPoint,
  type TableGeometry,
} from "../internal/table-geometry";

const addIcon = symbol("add");
const gripIcon = symbol("drag-indicator");
const duplicateIcon = symbol("content-copy");
const clearIcon = symbol("format-clear");
const deleteIcon = symbol("delete");
const fitIcon = symbol("fit-width");
const alignLeftIcon = symbol("format-align-left");
const alignCenterIcon = symbol("format-align-center");
const alignRightIcon = symbol("format-align-right");

/** A row or a column of the grid. */
type Axis = "row" | "col";

export interface ChromeState {
  /** The cell under the pointer. */
  hover: { r: number; c: number } | null;
  /** The insert point the pointer is near, and whether its "+" is hovered. */
  insert: (InsertPoint & { hovered: boolean }) | null;
  /** The open grip menu. */
  menu: { kind: Axis; i: number } | null;
  /** A row / column being dragged to gap `to`, `delta` px from where it started. */
  drag: { kind: Axis; from: number; to: number; delta: number } | null;
  /** The column whose right border is being dragged. */
  resizing: number | null;
}

export const IDLE_CHROME: ChromeState = {
  hover: null,
  insert: null,
  menu: null,
  drag: null,
  resizing: null,
};

/** A new column's width in a table whose columns have fixed widths. */
const NEW_COLUMN_WIDTH = 140;
/** The narrowest a column may be dragged or fitted to; and the widest a fit makes it. */
const MIN_COLUMN_WIDTH = 64;
const MAX_FIT_WIDTH = 560;
/** How far a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Grip, insert point, add bar and resize handle sizes (px). */
const GRIP_LONG = 20;
const GRIP_SHORT = 12;
const INSERT_SIZE = 16;
const ADD_BAR = 12;
const ADD_GAP = 3;
const RESIZE_HIT = 8;
const LINE = 2;

export interface TableChromeProps {
  data: TableData;
  geometry: TableGeometry;
  state: ChromeState;
  setState: React.Dispatch<React.SetStateAction<ChromeState>>;
  /** Write a change against the table's current data (the open cell's draft folded in). */
  write(change?: (d: TableData) => TableData): TableData;
  /** Open a cell for editing — after `change`, when the gesture also edits. */
  open(
    r: number,
    c: number,
    caret: RichTextFieldCaret,
    change?: (d: TableData) => TableData,
  ): void;
  /** Draw the table at these widths until a resize is released (`null` = stored). */
  setPreviewWidths(widths: readonly number[] | null): void;
  hostRef: RefObject<HTMLDivElement | null>;
  tableRef: RefObject<HTMLTableElement | null>;
}

/**
 * Everything drawn AROUND the cells, placed from the measured geometry:
 *
 * - a slim GRIP on the left border of the hovered row and the top border of
 *   the hovered column — click for its menu, drag to move the row / column
 *   (the header row stays first);
 * - an INSERT POINT, a small "+" centred where a column border meets the top
 *   edge (or a row border the left edge), shown as the pointer comes near it —
 *   hovering it draws the line it would insert at;
 * - an ADD BAR beside the last row / last column, while it is hovered;
 * - a RESIZE handle on every column's right border (double-click: fit the
 *   column to its content).
 *
 * Highlights are neutral (the muted foreground), never the accent.
 */
export function TableChrome({
  data,
  geometry: g,
  state,
  setState,
  write,
  open,
  setPreviewWidths,
  hostRef,
  tableRef,
}: TableChromeProps) {
  const rowGrip = useRef<HTMLButtonElement>(null);
  const colGrip = useRef<HTMLButtonElement>(null);
  const [edge, setEdge] = useState<"bottom" | "right" | null>(null);
  const [resizeHover, setResizeHover] = useState<number | null>(null);
  // When a menu last closed, and whose: a press on its own grip closes it (the
  // popover's outside-press) BEFORE the grip sees the press, which must then
  // not open it again.
  const lastClosed = useRef<{ kind: Axis; i: number; at: number } | null>(null);

  const rows = g.rows.length;
  const cols = g.cols.length;
  const colEdges = gaps(g.cols);
  const rowEdges = gaps(g.rows);
  const { table } = g;
  const { hover, menu, drag, insert } = state;
  const busy = drag !== null || state.resizing !== null;

  const gripOf = (kind: Axis): number | null => {
    if (drag) return drag.kind === kind ? drag.from : null;
    if (menu) return menu.kind === kind ? menu.i : null;
    if (!hover) return null;
    return kind === "row" ? hover.r : hover.c;
  };
  const rowIdx = gripOf("row");
  const colIdx = gripOf("col");

  const drawnWidths = () => g.cols.map((s) => Math.round(s.end - s.start));

  const startGrip = (kind: Axis, i: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const host = hostRef.current;
    if (!host) return;
    const closed = lastClosed.current;
    const wasOpen =
      (menu?.kind === kind && menu.i === i) ||
      (closed?.kind === kind &&
        closed.i === i &&
        performance.now() - closed.at < 400);
    const origin = host.getBoundingClientRect();
    const along = (ev: { clientX: number; clientY: number }) =>
      kind === "col" ? ev.clientX - origin.left : ev.clientY - origin.top;
    const start = along(e);
    const edges = kind === "col" ? colEdges : rowEdges;
    // The header row stays first: it neither moves nor is moved above.
    const movable = !(kind === "row" && i === 0);
    let to: number | null = null;
    const move = (ev: PointerEvent) => {
      const p = along(ev);
      if (to === null && Math.abs(p - start) < DRAG_THRESHOLD) return;
      if (!movable) return;
      to = nearestGap(edges, p, kind === "row" ? 1 : 0);
      const next = { kind, from: i, to, delta: p - start };
      setState((s) => ({ ...s, menu: null, insert: null, drag: next }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setState((s) => ({ ...s, drag: null }));
      if (to === null) {
        if (!wasOpen) setState((s) => ({ ...s, menu: { kind, i } }));
        return;
      }
      const gap = to;
      if (gap === i || gap === i + 1) return;
      write((d) =>
        kind === "col" ? moveColumn(d, i, gap) : moveRow(d, i, gap),
      );
      // The grip follows the row / column it moved.
      setState((s) => ({
        ...s,
        hover: s.hover && {
          ...s.hover,
          [kind === "col" ? "c" : "r"]: movedTo(i, gap),
        },
      }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (c: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const drawn = drawnWidths();
    const startX = e.clientX;
    let width = drawn[c]!;
    setState((s) => ({ ...s, resizing: c, insert: null }));
    const move = (ev: PointerEvent) => {
      width = Math.max(MIN_COLUMN_WIDTH, drawn[c]! + ev.clientX - startX);
      setPreviewWidths(drawn.map((w, j) => (j === c ? width : w)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setState((s) => ({ ...s, resizing: null }));
      setPreviewWidths(null);
      // ONE write for the whole drag, so one undo entry.
      write((d) => resizeColumn(d, c, width, drawn));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const fitColumn = (c: number) => {
    const t = tableRef.current;
    const host = hostRef.current;
    if (!t || !host) return;
    const width = contentWidth(t, host, c);
    write((d) => resizeColumn(d, c, width, drawnWidths()));
  };

  const closeMenu = useEventCallback(() => {
    if (menu) lastClosed.current = { ...menu, at: performance.now() };
    setState((s) => ({ ...s, menu: null }));
  });
  const act = useEventCallback((change: (d: TableData) => TableData) => {
    write(change);
    closeMenu();
  });

  const showGrips = !(state.resizing !== null);
  const lastRowHovered = hover?.r === rows - 1 || edge === "bottom";
  const lastColHovered = hover?.c === cols - 1 || edge === "right";

  return (
    <>
      {/* Resize handles: every column's right border, the table's full height. */}
      {!drag &&
        g.cols.map((span, c) => {
          const lit = state.resizing === c || (!busy && resizeHover === c);
          return (
            <Placed
              // Columns carry no identity beyond their position.
              key={c}
              layer="raised"
              x={{ center: span.end, size: RESIZE_HIT }}
              y={{ start: table.top, size: table.height }}
              className="cursor-col-resize"
              onPointerEnter={() => setResizeHover(c)}
              onPointerLeave={() => setResizeHover(null)}
              onPointerDown={startResize(c)}
              onDoubleClick={() => fitColumn(c)}
              title="Drag to resize · double-click to fit"
            >
              {lit ? (
                <Placed
                  decorative
                  x={{ center: "50%", size: LINE }}
                  y="fill"
                  className="bg-muted-foreground/40"
                />
              ) : null}
            </Placed>
          );
        })}

      {/* The line an insert point would insert at, or a drag would drop at. */}
      {insert?.hovered && !busy ? (
        <Line
          kind={insert.kind}
          at={insert.kind === "col" ? colEdges[insert.k]! : rowEdges[insert.k]!}
          g={g}
        />
      ) : null}
      {drag ? (
        <Line
          kind={drag.kind}
          at={drag.kind === "col" ? colEdges[drag.to]! : rowEdges[drag.to]!}
          g={g}
        />
      ) : null}

      {/* Insert point: a "+" on the intersection the pointer is near. */}
      {insert && !busy ? (
        <Center
          as="button"
          aria-label={insert.kind === "col" ? "Insert column" : "Insert row"}
          title={insert.kind === "col" ? "Insert column" : "Insert row"}
          style={placedStyle(
            {
              center: insert.kind === "col" ? colEdges[insert.k]! : table.left,
              size: INSERT_SIZE,
            },
            {
              center: insert.kind === "col" ? table.top : rowEdges[insert.k]!,
              size: INSERT_SIZE,
            },
          )}
          className={cn(
            placedClasses({ layer: "raised" }),
            "rounded-full border bg-background text-muted-foreground shadow-xs",
            insert.hovered
              ? "border-muted-foreground/40 bg-muted text-foreground"
              : "border-border",
          )}
          onPointerEnter={() =>
            setState((s) =>
              s.insert ? { ...s, insert: { ...s.insert, hovered: true } } : s,
            )
          }
          onPointerLeave={() =>
            setState((s) =>
              s.insert ? { ...s, insert: { ...s.insert, hovered: false } } : s,
            )
          }
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          onClick={() => {
            const { kind, k } = insert;
            setState((s) => ({ ...s, insert: null }));
            if (kind === "col") {
              open(0, k, "start", (d) => insertColumn(d, k, NEW_COLUMN_WIDTH));
            } else {
              open(k, 0, "start", (d) => insertRow(d, k));
            }
          }}
        >
          <Icon icon={addIcon} className="size-3" />
        </Center>
      ) : null}

      {/* Grips, on the border line of the hovered row and column. */}
      {showGrips && rowIdx !== null && rowIdx < rows ? (
        <Grip
          ref={rowGrip}
          kind="row"
          on={menu?.kind === "row" || drag?.kind === "row"}
          label={rowIdx === 0 ? "Header row" : `Row ${rowIdx}`}
          x={{ center: table.left, size: GRIP_SHORT }}
          y={{
            center:
              (g.rows[rowIdx]!.start + g.rows[rowIdx]!.end) / 2 +
              (drag?.kind === "row" ? drag.delta : 0),
            size: GRIP_LONG,
          }}
          onPointerDown={startGrip("row", rowIdx)}
        />
      ) : null}
      {showGrips && colIdx !== null && colIdx < cols ? (
        <Grip
          ref={colGrip}
          kind="col"
          on={menu?.kind === "col" || drag?.kind === "col"}
          label={`Column ${colIdx + 1}`}
          x={{
            center:
              (g.cols[colIdx]!.start + g.cols[colIdx]!.end) / 2 +
              (drag?.kind === "col" ? drag.delta : 0),
            size: GRIP_LONG,
          }}
          y={{ center: table.top, size: GRIP_SHORT }}
          onPointerDown={startGrip("col", colIdx)}
        />
      ) : null}

      {/* Add bars, beside the last row / last column while it is hovered. */}
      {!busy && lastRowHovered ? (
        <AddBar
          label="Add row"
          x={{ start: table.left, size: table.width }}
          y={{ start: table.top + table.height + ADD_GAP, size: ADD_BAR }}
          onHover={(on) => setEdge(on ? "bottom" : null)}
          onAdd={() => open(rows, 0, "start", (d) => insertRow(d, rows))}
        />
      ) : null}
      {!busy && lastColHovered ? (
        <AddBar
          label="Add column"
          x={{ start: table.left + table.width + ADD_GAP, size: ADD_BAR }}
          y={{ start: table.top, size: table.height }}
          onHover={(on) => setEdge(on ? "right" : null)}
          onAdd={() =>
            open(0, cols, "start", (d) =>
              insertColumn(d, cols, NEW_COLUMN_WIDTH),
            )
          }
        />
      ) : null}

      {/* The grip menus. */}
      <ControlPanelPopover
        anchor={rowGrip}
        open={menu?.kind === "row"}
        onOpenChange={(next) => {
          if (!next) closeMenu();
        }}
        label="Row actions"
      >
        {menu?.kind === "row" ? (
          <ControlPanel.Section>
            <ControlPanel.Row
              icon={<Icon icon={duplicateIcon} />}
              disabled={menu.i === 0}
              onSelect={() => act((d) => duplicateRow(d, menu.i))}
            >
              Duplicate
            </ControlPanel.Row>
            <ControlPanel.Row
              icon={<Icon icon={clearIcon} />}
              onSelect={() => act((d) => clearRow(d, menu.i))}
            >
              Clear contents
            </ControlPanel.Row>
            <ControlPanel.Row
              icon={<Icon icon={deleteIcon} />}
              tone="danger"
              disabled={menu.i === 0}
              hint={menu.i === 0 ? "A table keeps its header row" : undefined}
              onSelect={() => act((d) => deleteRow(d, menu.i))}
            >
              Delete row
            </ControlPanel.Row>
          </ControlPanel.Section>
        ) : null}
      </ControlPanelPopover>
      <ControlPanelPopover
        anchor={colGrip}
        open={menu?.kind === "col"}
        onOpenChange={(next) => {
          if (!next) closeMenu();
        }}
        label="Column actions"
      >
        {menu?.kind === "col" ? (
          <>
            <ControlPanel.Section>
              <ControlPanel.Setting
                label="Align"
                fit="inline"
                control={
                  <SegmentedControl<AlignId>
                    label="Align"
                    variant="ghost"
                    options={ALIGN_OPTIONS}
                    value={data.align[menu.i] ?? "left"}
                    onChange={(id) =>
                      write((d) => setAlign(d, menu.i, alignOf(id)))
                    }
                  />
                }
              />
            </ControlPanel.Section>
            <ControlPanel.Section>
              <ControlPanel.Row
                icon={<Icon icon={fitIcon} />}
                onSelect={() => {
                  fitColumn(menu.i);
                  closeMenu();
                }}
              >
                Fit to content
              </ControlPanel.Row>
              <ControlPanel.Row
                icon={<Icon icon={duplicateIcon} />}
                onSelect={() => act((d) => duplicateColumn(d, menu.i))}
              >
                Duplicate
              </ControlPanel.Row>
              <ControlPanel.Row
                icon={<Icon icon={clearIcon} />}
                onSelect={() => act((d) => clearColumn(d, menu.i))}
              >
                Clear contents
              </ControlPanel.Row>
              <ControlPanel.Row
                icon={<Icon icon={deleteIcon} />}
                tone="danger"
                disabled={cols <= 1}
                hint={
                  cols <= 1 ? "A table keeps at least one column" : undefined
                }
                onSelect={() => act((d) => deleteColumn(d, menu.i))}
              >
                Delete column
              </ControlPanel.Row>
            </ControlPanel.Section>
          </>
        ) : null}
      </ControlPanelPopover>
    </>
  );
}

type AlignId = "left" | "center" | "right";

const ALIGN_OPTIONS = [
  { id: "left", icon: <Icon icon={alignLeftIcon} />, tooltip: "Left" },
  { id: "center", icon: <Icon icon={alignCenterIcon} />, tooltip: "Center" },
  { id: "right", icon: <Icon icon={alignRightIcon} />, tooltip: "Right" },
] as const satisfies readonly {
  id: AlignId;
  icon: React.ReactNode;
  tooltip: string;
}[];

/** Left is a plain `---`: GFM's default, stated by nothing. */
function alignOf(id: AlignId): TableAlign {
  return id === "left" ? null : id;
}

function Grip({
  ref,
  kind,
  on,
  label,
  x,
  y,
  onPointerDown,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  kind: Axis;
  on: boolean;
  label: string;
  x: Extent;
  y: Extent;
  onPointerDown(e: React.PointerEvent): void;
}) {
  return (
    <Center
      as="button"
      ref={ref}
      aria-label={`${label} — drag to move, click for options`}
      title="Drag to move · click for options"
      style={placedStyle(x, y)}
      className={cn(
        placedClasses({ layer: "raised" }),
        "cursor-grab touch-none rounded-sm border shadow-xs",
        on
          ? "border-muted-foreground/40 bg-muted text-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onPointerDown={onPointerDown}
    >
      <Icon
        icon={gripIcon}
        className={cn("size-3", kind === "col" && "rotate-90")}
      />
    </Center>
  );
}

function AddBar({
  label,
  x,
  y,
  onHover,
  onAdd,
}: {
  label: string;
  x: Extent;
  y: Extent;
  onHover(on: boolean): void;
  onAdd(): void;
}) {
  return (
    <Center
      as="button"
      aria-label={label}
      title={label}
      style={placedStyle(x, y)}
      className={cn(
        placedClasses({ layer: "raised" }),
        "rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
      onClick={onAdd}
    >
      <Icon icon={addIcon} className="size-2.5" />
    </Center>
  );
}

/** A 2px neutral line across the table at a column (x) or row (y) gap. */
function Line({ kind, at, g }: { kind: Axis; at: number; g: TableGeometry }) {
  return (
    <Placed
      decorative
      layer="raised"
      x={
        kind === "col"
          ? { center: at, size: LINE }
          : { start: g.table.left, size: g.table.width }
      }
      y={
        kind === "col"
          ? { start: g.table.top, size: g.table.height }
          : { center: at, size: LINE }
      }
      className="bg-muted-foreground/50"
    />
  );
}

/**
 * Column `c`'s width with each of its cells on ONE line: every cell's content,
 * laid out unwrapped in an invisible probe inheriting the cell's font, plus the
 * cell's own padding and border — capped, so one long cell cannot stretch the
 * table across the page.
 */
function contentWidth(
  table: HTMLTableElement,
  host: HTMLElement,
  c: number,
): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;left:0;top:0;width:max-content";
  host.appendChild(probe);
  let widest = 0;
  for (const tr of Array.from(table.rows)) {
    const cell = tr.cells[c];
    if (!cell) continue;
    const style = getComputedStyle(cell);
    probe.style.font = style.font;
    probe.innerHTML = cell.innerHTML;
    const chrome =
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.borderRightWidth);
    widest = Math.max(widest, probe.getBoundingClientRect().width + chrome);
  }
  probe.remove();
  return Math.min(MAX_FIT_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest)));
}
