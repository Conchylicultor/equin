import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import {
  BLOCK_INSET,
  RichTextField,
  WideBlock,
  selectableText,
  useBlockActivate,
  useInnerCaret,
  useSelectionControl,
  type BlockRendererProps,
  type RichTextFieldCaret,
  type RichTextFieldKey,
} from "@plugins/page/plugins/editor/web";
import { dataEqual, type RichText } from "@plugins/page/plugins/editor/core";
import { columnWidths, tableBlock, type TableData } from "../../core";
import {
  cellsIn,
  clearCells,
  insertRow,
  pasteCells,
  rowAt,
  rowCount,
  setCell,
} from "../internal/table-ops";
import {
  boundsOf,
  cellRange,
  clampRange,
  isArrowKey,
  sameCell,
  stepCell,
  wholeTable,
  type Cell,
  type CellBounds,
  type CellRange,
} from "../internal/cell-range";
import { isCellGrid, readCells, writeCells } from "../internal/cell-clipboard";
import {
  insertPointNear,
  measureTable,
  sameGeometry,
  spanAt,
  type TableGeometry,
} from "../internal/table-geometry";
import {
  CellText,
  ColumnWidths,
  alignStyle,
  cellClass,
  tableSizing,
} from "./table-cells";
import {
  IDLE_CHROME,
  NEW_COLUMN_WIDTH,
  TableChrome,
  type ChromeState,
} from "./table-chrome";

/**
 * The cell being edited, where its caret lands when it opens, and the text it
 * opens with — taken from the data the opening write PRODUCED, never from the
 * render: a write reaches `block.data` a render later, so a cell opened by the
 * same gesture that inserted it would otherwise open on its old neighbour's
 * text (or not exist yet).
 */
interface ActiveCell {
  r: number;
  c: number;
  caret: RichTextFieldCaret;
  initial: RichText;
}

/** The active cell's text since it opened, not yet written. */
interface Draft {
  r: number;
  c: number;
  runs: RichText;
}

/**
 * The table block, edited in place like Notion's: click a cell and type.
 *
 * ## One cell at a time, written when you leave it
 *
 * The cells are rich text in the block's `data` (no content doc), so only the
 * ACTIVE cell mounts an editor (`RichTextField`); every other cell is painted
 * by the read-only runs renderer, as `TableView` paints them. What the active
 * cell's editor holds is a DRAFT, written when the cell is left — another cell,
 * a structural action, the caret leaving the block — as ONE `editor.update`
 * (one undo entry; while the cell is open ⌘Z undoes keystrokes).
 *
 * Every write is computed against the block's CURRENT data (`latest`), never a
 * snapshot taken when the cell opened: a cell's write replaces that cell, so an
 * agent's concurrent edit to another cell survives. A structural action folds
 * the pending draft in, so typing then Tab-into-a-new-row is one write.
 *
 * ## Keys
 *
 * The field hands every key here first (`onKey`), with where its caret stands:
 * Tab / Shift+Tab walk the cells (Tab on the last appends a row), Enter moves
 * down (appending from the last row), ↑/↓ cross rows from a cell's first/last
 * line and ←/→ cross cells at a text edge; Escape writes the cell and selects
 * it (a second Escape selects the table). What the grid does not take stays
 * the field's (typing, marks, Shift+Enter's soft break) — or, for ↑/↓ past the
 * table's edge, the caret host's: it moves the caret to the next block. Enter
 * on the selected table opens its first cell.
 *
 * ## Selecting cells
 *
 * A rectangle of cells (`range`) is selected by a drag that crosses into
 * another cell (the words it had selected natively are dropped), Shift+click,
 * Shift+arrows out of a cell's text edge, or Escape in a cell; it is never
 * held at once with an open cell. While it is, the keyboard is on the grid's
 * host: arrows move it, Shift+arrows grow it, Tab walks it, ⌘A takes every
 * cell, Backspace / Delete clear it (one write), Enter or typing opens its
 * focus cell (typing replaces the text), Escape selects the table. ⌘C / ⌘X /
 * ⌘V copy, cut and paste it — as cells, HTML and tab-separated text
 * (`cell-clipboard.ts`), so a range goes to and from another table or a
 * spreadsheet; a paste grows the table to fit. A grid pasted into an open cell
 * spreads across the table from it.
 *
 * ## Chrome
 *
 * Grips, insert points, add bars and resize handles (`TableChrome`) are placed
 * from the table's measured geometry, taken after every render.
 */
export function TableBlock({ block, editor }: BlockRendererProps) {
  const data = tableBlock.parse(block.data);
  const latest = useLatestRef(data);
  const draft = useRef<Draft | null>(null);
  const [active, setActive] = useState<ActiveCell | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [geometry, setGeometry] = useState<TableGeometry | null>(null);
  const [chrome, setChrome] = useState<ChromeState>(IDLE_CHROME);
  // The selected cells — never held at once with an open cell (`active`).
  const [range, setRange] = useState<CellRange | null>(null);
  // A drag is selecting cells: the table takes no native text selection.
  const [selectingCells, setSelectingCells] = useState(false);
  // The click that ends a cell-selecting drag (or a Shift+click) opens no cell.
  const swallowClick = useRef(false);
  // Widths drawn while a resize is in progress — written once, on release.
  const [previewWidths, setPreviewWidths] = useState<readonly number[] | null>(
    null,
  );

  const selection = useSelectionControl();
  const rows = rowCount(data);
  const cols = data.header.length;
  // A write can shrink the table under the selection.
  const shown = range && clampRange(range, rows, cols);

  // Every change goes through here: the draft folded in, then `change`, against
  // the current data — and nothing written when nothing changed.
  const write = useEventCallback(
    (change: (d: TableData) => TableData = (d) => d): TableData => {
      const base = latest.current;
      const pending = draft.current;
      draft.current = null;
      const withDraft =
        pending && pending.r < rowCount(base) && pending.c < base.header.length
          ? setCell(base, pending.r, pending.c, pending.runs)
          : base;
      const next = change(withDraft);
      if (!dataEqual(next, base)) editor.update(next);
      return next;
    },
  );

  // Open cell (r, c) — after `change`, written first, when the gesture is
  // also an edit (Tab out of the last cell appends the row it opens).
  const open = useEventCallback(
    (
      r: number,
      c: number,
      caret: RichTextFieldCaret,
      change?: (d: TableData) => TableData,
      seed?: RichText,
    ) => {
      const next = write(change);
      setRange(null);
      // A `seed` replaces the cell's text, as typing over a selected cell does
      // — a draft until the cell is left, so typing on is one write.
      if (seed) draft.current = { r, c, runs: seed };
      setActive({ r, c, caret, initial: seed ?? rowAt(next, r)[c]! });
    },
  );

  // Select cells: the open cell written and closed, the keyboard on the grid.
  const selectCells = useEventCallback((next: CellRange) => {
    write();
    setActive(null);
    setRange(next);
    hostRef.current?.focus({ preventScroll: true });
    // The closed field's caret would otherwise linger in its cell, and a copy
    // targets the selection's node rather than the focused grid.
    getSelection()?.removeAllRanges();
  });

  // Paste a grid onto `b` (one write), then select what it covers.
  const pasteInto = (b: CellBounds, cells: RichText[][]) => {
    let landed = b;
    write((d) => {
      const out = pasteCells(d, b, cells, NEW_COLUMN_WIDTH);
      landed = out.bounds;
      return out.data;
    });
    selectCells({
      anchor: { r: landed.r0, c: landed.c0 },
      focus: { r: landed.r1, c: landed.c1 },
    });
  };

  // A block leaving the page mid-edit still writes what was typed.
  useEffect(
    () => () => {
      write();
    },
    [write],
  );

  useBlockActivate(active ? null : () => open(0, 0, "end"));
  // An open cell draws its own ring, a cell selection its own box; the table
  // itself looks the same whether or not you are in it (no block-level tint).
  useInnerCaret(active !== null || shown !== null);

  const measure = useEventCallback((): TableGeometry | null => {
    const host = hostRef.current;
    const table = tableRef.current;
    if (!host || !table) return null;
    const next = measureTable(host, table);
    setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    return next;
  });
  // The chrome is drawn only while it can be used — the pointer over the
  // table, or a menu / drag / resize under way — and only then is the table
  // measured: a page of large tables nobody is pointing at pays no layout read.
  const [pointerIn, setPointerIn] = useState(false);
  const chromeLive =
    pointerIn ||
    shown !== null ||
    chrome.menu !== null ||
    chrome.drag !== null ||
    chrome.resizing !== null;
  // After every render while it is live: placed from what is on screen.
  useLayoutEffect(() => {
    if (chromeLive) void measure();
  });

  const onKey = (r: number, c: number) => (k: RichTextFieldKey) => {
    const plain = !k.mod && !k.alt;
    const last = rows * cols - 1;
    const flat = r * cols + c;
    const at = (i: number) => [Math.floor(i / cols), i % cols] as const;
    if (k.key === "Escape") {
      // Out of the cell, the cell selected — a second Escape selects the
      // table, as Escape does in a text block.
      selectCells(cellRange({ r, c }));
      return true;
    }
    if (k.shift && !k.mod && !k.alt && isArrowKey(k.key)) {
      // Past the text's edge, Shift+arrow selects cells: this one and the next.
      const atEdge = {
        ArrowLeft: k.atStart,
        ArrowRight: k.atEnd,
        ArrowUp: k.onTopLine,
        ArrowDown: k.onBottomLine,
      }[k.key];
      if (!atEdge) return false;
      selectCells({
        anchor: { r, c },
        focus: stepCell({ r, c }, k.key, rows, cols),
      });
      return true;
    }
    if (k.key === "Tab" && !k.mod && !k.alt) {
      if (k.shift) {
        if (flat > 0) open(...at(flat - 1), "end");
        return true;
      }
      if (flat < last) {
        open(...at(flat + 1), "end");
        return true;
      }
      open(rows, 0, "start", (d) => insertRow(d, rowCount(d)));
      return true;
    }
    if (k.key === "Enter" && plain && !k.shift) {
      if (r + 1 < rows) {
        open(r + 1, c, "end");
        return true;
      }
      open(rows, c, "start", (d) => insertRow(d, rowCount(d)));
      return true;
    }
    if (k.key === "ArrowUp" && plain && !k.shift && k.onTopLine && r > 0) {
      open(r - 1, c, { column: k.caretX, edge: "bottom" });
      return true;
    }
    if (
      k.key === "ArrowDown" &&
      plain &&
      !k.shift &&
      k.onBottomLine &&
      r + 1 < rows
    ) {
      open(r + 1, c, { column: k.caretX, edge: "top" });
      return true;
    }
    if (k.key === "ArrowLeft" && plain && !k.shift && k.atStart && flat > 0) {
      open(...at(flat - 1), "end");
      return true;
    }
    if (k.key === "ArrowRight" && plain && !k.shift && k.atEnd && flat < last) {
      open(...at(flat + 1), "start");
      return true;
    }
    return false;
  };

  // The cell under a viewport point, or `null` off the table.
  const cellAt = (x: number, y: number): Cell | null => {
    const g = measure();
    const host = hostRef.current;
    if (!g || !host) return null;
    const origin = host.getBoundingClientRect();
    const px = x - origin.left;
    const py = y - origin.top;
    const { table } = g;
    if (
      px < table.left ||
      px > table.left + table.width ||
      py < table.top ||
      py > table.top + table.height
    ) {
      return null;
    }
    return { r: spanAt(g.rows, py), c: spanAt(g.cols, px) };
  };

  // A press on a cell: Shift extends the selection to it; a drag that crosses
  // into another cell selects the rectangle between them — until then it is
  // the browser's, selecting the cell's words.
  const onCellPointerDown = (at: Cell) => (e: React.PointerEvent) => {
    swallowClick.current = false;
    if (e.button !== 0) return;
    let anchor = at;
    let selecting = false;
    if (e.shiftKey) {
      anchor = shown?.anchor ?? (active ? { r: active.r, c: active.c } : at);
      selecting = true;
      swallowClick.current = true;
      selectCells({ anchor, focus: at });
    }
    const move = (ev: PointerEvent) => {
      const to = cellAt(ev.clientX, ev.clientY);
      if (!to) return;
      if (!selecting) {
        if (sameCell(to, anchor)) return;
        selecting = true;
        // Committed before the browser's next move extends its selection.
        flushSync(() => setSelectingCells(true));
        selectCells({ anchor, focus: to });
      }
      getSelection()?.removeAllRanges();
      setRange((s) =>
        s && sameCell(s.anchor, anchor) && sameCell(s.focus, to)
          ? s
          : { anchor, focus: to },
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setSelectingCells(false);
      if (selecting) swallowClick.current = true;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // The keyboard while cells are selected — only keys that land on the grid's
  // host itself (an open cell's keys are the field's, through `onKey`).
  const onGridKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || !shown) return;
    const mod = e.metaKey || e.ctrlKey;
    const { anchor, focus } = shown;
    const take = () => e.preventDefault();
    if (e.key === "Escape") {
      take();
      setRange(null);
      selection?.enterSelectionMode(block.id);
      return;
    }
    if (isArrowKey(e.key) && !mod && !e.altKey) {
      take();
      const to = stepCell(focus, e.key, rows, cols);
      setRange(e.shiftKey ? { anchor, focus: to } : cellRange(to));
      return;
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      take();
      const flat = focus.r * cols + focus.c + (e.shiftKey ? -1 : 1);
      const i = Math.min(rows * cols - 1, Math.max(0, flat));
      setRange(cellRange({ r: Math.floor(i / cols), c: i % cols }));
      return;
    }
    if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey) {
      take();
      open(focus.r, focus.c, "end");
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !mod && !e.altKey) {
      take();
      write((d) => clearCells(d, boundsOf(shown)));
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
      take();
      setRange(wholeTable(rows, cols));
      return;
    }
    // A printable key types over the focus cell (a composition starts with
    // the next one: its first key carries no character).
    if (!mod && !e.altKey && e.key.length === 1) {
      take();
      open(focus.r, focus.c, "end", undefined, [{ text: e.key }]);
    }
  };

  // The clipboard is the grid's while it holds focus — asked of the document,
  // not of the event's target, which is wherever a stale DOM selection sits.
  const gridOwnsClipboard = (e: React.ClipboardEvent) =>
    shown !== null && document.activeElement === e.currentTarget;
  const onGridCopy = (e: React.ClipboardEvent) => {
    if (!gridOwnsClipboard(e) || !shown) return;
    e.preventDefault();
    writeCells(e.clipboardData, cellsIn(data, boundsOf(shown)));
  };
  const onGridCut = (e: React.ClipboardEvent) => {
    if (!gridOwnsClipboard(e) || !shown) return;
    e.preventDefault();
    const b = boundsOf(shown);
    writeCells(e.clipboardData, cellsIn(data, b));
    write((d) => clearCells(d, b));
  };
  // Captured, ahead of the open cell's editor: a grid pasted into a cell
  // spreads across the table rather than landing in the cell as text.
  const onGridPasteCapture = (e: React.ClipboardEvent) => {
    const host = e.currentTarget;
    if (gridOwnsClipboard(e) && shown) {
      e.preventDefault();
      e.stopPropagation();
      const pasted = readCells(e.clipboardData);
      if (pasted) pasteInto(boundsOf(shown), pasted.cells);
      return;
    }
    if (!active || !(e.target instanceof Node) || !host.contains(e.target)) {
      return;
    }
    const pasted = readCells(e.clipboardData);
    if (!pasted || !isCellGrid(pasted, e.clipboardData)) return;
    e.preventDefault();
    e.stopPropagation();
    pasteInto(boundsOf(cellRange({ r: active.r, c: active.c })), pasted.cells);
  };
  // Focus leaving the table drops the selection (not focus moving into a cell).
  const onGridBlur = (e: React.FocusEvent) => {
    if (e.target !== e.currentTarget) return;
    const to = e.relatedTarget;
    if (to instanceof Node && e.currentTarget.contains(to)) return;
    setRange(null);
  };

  const onFieldBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    write();
    const to = e.relatedTarget;
    // Focus that moved into one of this cell's own popups (the format
    // toolbar's link field) comes back: the cell stays open. A popup is drawn
    // in its own layer under <body>, never inside the app's tree — so focus
    // anywhere in the tree the table is in (another block, the title) or
    // nowhere closes it.
    const host = hostRef.current;
    if (to instanceof Element && host && layerOf(to) !== layerOf(host)) return;
    setActive(null);
  };

  const widths = previewWidths ?? columnWidths(data);
  const sizing = tableSizing(data, widths);
  const band =
    chrome.drag ??
    (chrome.menu ? { kind: chrome.menu.kind, from: chrome.menu.i } : null);

  return (
    <Inset
      x={BLOCK_INSET}
      y="xs"
      onPointerEnter={() => setPointerIn(true)}
      onPointerMove={(e) => {
        // The pointer is read against the table as it is NOW (the first move
        // over it comes before any measurement).
        const g = measure();
        setChrome((s) => pointerChrome(s, g, hostRef.current, e));
      }}
      onPointerLeave={() => {
        setPointerIn(false);
        setChrome((s) =>
          s.menu || s.drag || s.resizing !== null ? s : IDLE_CHROME,
        );
      }}
    >
      <WideBlock>
        <div
          ref={hostRef}
          // Focusable so the keyboard and clipboard reach the grid while cells
          // are selected (no cell's editor is open then).
          tabIndex={-1}
          aria-label="Table"
          className="relative outline-none"
          onKeyDown={onGridKey}
          onCopy={onGridCopy}
          onCut={onGridCut}
          onPasteCapture={onGridPasteCapture}
          onBlur={onGridBlur}
        >
          <Scroll axis="x" onScroll={() => measure()}>
            <table
              {...selectableText}
              ref={tableRef}
              className={cn(
                "border-collapse",
                (shown !== null || selectingCells) && "select-none",
                sizing.className,
                textVariantClass("body"),
              )}
              style={sizing.style}
            >
              <ColumnWidths widths={widths} />
              <tbody>
                {Array.from({ length: rows }, (_, r) => (
                  // Rows and cells are positions in the stored arrays — their
                  // index IS their identity.
                  <tr key={r}>
                    {rowAt(data, r).map((runs, c) => {
                      const Tag = r === 0 ? "th" : "td";
                      const isActive = active?.r === r && active.c === c;
                      const inBand =
                        band !== null &&
                        (band.kind === "row"
                          ? band.from === r
                          : band.from === c);
                      return (
                        <Tag
                          key={c}
                          className={cn(
                            cellClass(r === 0),
                            "cursor-text",
                            isActive &&
                              "ring-1 ring-inset ring-muted-foreground/60",
                            inBand && "bg-foreground/5",
                          )}
                          style={alignStyle(data.align[c])}
                          onPointerDown={onCellPointerDown({ r, c })}
                          onMouseDown={(e) => {
                            // Shift+click extends the cell selection, not a
                            // native one.
                            if (e.shiftKey) e.preventDefault();
                          }}
                          onClick={(e) => {
                            if (swallowClick.current) {
                              swallowClick.current = false;
                              return;
                            }
                            if (isActive) return;
                            // A drag across cells selected their words (the
                            // table is selectable text): that was a selection,
                            // not a click into this cell.
                            if (getSelection()?.isCollapsed === false) return;
                            // The cell opens with its caret where the click landed.
                            open(r, c, { x: e.clientX, y: e.clientY });
                          }}
                        >
                          {isActive ? (
                            <RichTextField
                              key={`${r}:${c}`}
                              initial={active.initial}
                              caret={active.caret}
                              ariaLabel={
                                r === 0
                                  ? `Header, column ${c + 1}`
                                  : `Row ${r}, column ${c + 1}`
                              }
                              onChange={(next) => {
                                draft.current = { r, c, runs: next };
                              }}
                              onKey={onKey(r, c)}
                              onBlur={onFieldBlur}
                            />
                          ) : (
                            <CellText runs={runs} />
                          )}
                        </Tag>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          {geometry && shown ? (
            <RangeBox geometry={geometry} bounds={boundsOf(shown)} />
          ) : null}
          {geometry && chromeLive ? (
            <TableChrome
              data={data}
              geometry={geometry}
              state={chrome}
              setState={setChrome}
              write={write}
              open={open}
              setPreviewWidths={setPreviewWidths}
              hostRef={hostRef}
              tableRef={tableRef}
            />
          ) : null}
        </div>
      </WideBlock>
    </Inset>
  );
}

/** The selected cells' box: the text-selection colour over them. */
function RangeBox({
  geometry: g,
  bounds: b,
}: {
  geometry: TableGeometry;
  bounds: CellBounds;
}) {
  const left = g.cols[b.c0]?.start;
  const right = g.cols[b.c1]?.end;
  const top = g.rows[b.r0]?.start;
  const bottom = g.rows[b.r1]?.end;
  // A range wider than what is drawn yet (the write that grew the table
  // renders before it is measured) waits for the next measurement.
  if (
    left === undefined ||
    right === undefined ||
    top === undefined ||
    bottom === undefined
  ) {
    return null;
  }
  return (
    <Placed
      decorative
      data-cell-range=""
      x={{ start: left, size: right - left }}
      y={{ start: top, size: bottom - top }}
      style={{ backgroundColor: "var(--text-selection)" }}
    />
  );
}

/** The chrome's hover state for a pointer move over the table's box. */
function pointerChrome(
  s: ChromeState,
  g: TableGeometry | null,
  host: HTMLElement | null,
  e: React.PointerEvent,
): ChromeState {
  if (!g || !host || s.drag || s.resizing !== null) return s;
  const origin = host.getBoundingClientRect();
  const x = e.clientX - origin.left;
  const y = e.clientY - origin.top;
  const inside =
    x >= g.table.left &&
    x <= g.table.left + g.table.width &&
    y >= g.table.top &&
    y <= g.table.top + g.table.height;
  const hover = inside
    ? { r: spanAt(g.rows, y), c: spanAt(g.cols, x) }
    : s.hover;
  const near = s.menu ? null : insertPointNear(g, x, y);
  // The same point keeps its state (whether its "+" is hovered).
  const insert =
    near && s.insert?.kind === near.kind && s.insert.k === near.k
      ? s.insert
      : near && { ...near, hovered: false };
  if (
    hover?.r === s.hover?.r &&
    hover?.c === s.hover?.c &&
    insert?.kind === s.insert?.kind &&
    insert?.k === s.insert?.k
  ) {
    return s;
  }
  return { ...s, hover, insert };
}

/** The child of `<body>` an element is drawn in — the app's tree, or a popup's layer. */
function layerOf(el: Element): Element {
  let node = el;
  while (node.parentElement && node.parentElement !== node.ownerDocument.body) {
    node = node.parentElement;
  }
  return node;
}
