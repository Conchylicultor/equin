import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
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
import { insertRow, rowAt, rowCount, setCell } from "../internal/table-ops";
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
import { IDLE_CHROME, TableChrome, type ChromeState } from "./table-chrome";

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
 * the table. What the grid does not take stays the field's (typing, marks,
 * Shift+Enter's soft break) — or, for ↑/↓ past the table's edge, the caret
 * host's: it moves the caret to the next block. Enter on the selected table
 * opens its first cell.
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
  // Widths drawn while a resize is in progress — written once, on release.
  const [previewWidths, setPreviewWidths] = useState<readonly number[] | null>(
    null,
  );

  const selection = useSelectionControl();
  const rows = rowCount(data);
  const cols = data.header.length;

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
    ) => {
      const next = write(change);
      setActive({ r, c, caret, initial: rowAt(next, r)[c]! });
    },
  );

  // A block leaving the page mid-edit still writes what was typed.
  useEffect(
    () => () => {
      write();
    },
    [write],
  );

  useBlockActivate(active ? null : () => open(0, 0, "end"));
  // An open cell draws its own ring; the table itself looks the same whether
  // or not you are typing in it (no block-level tint on every click).
  useInnerCaret(active !== null);

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
      // Out of the cell, the table selected — what Escape does in a text
      // block (its keyboard plugin enters selection mode the same way).
      write();
      setActive(null);
      selection?.enterSelectionMode(block.id);
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
        <div ref={hostRef} className="relative">
          <Scroll axis="x" onScroll={() => measure()}>
            <table
              {...selectableText}
              ref={tableRef}
              className={cn(
                "border-collapse",
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
                          onClick={(e) => {
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
