import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  BLOCK_INSET,
  WideBlock,
  selectableText,
} from "@plugins/page/plugins/editor/web";
import type { RichText } from "@plugins/page/plugins/editor/core";
import { columnWidths, type TableData } from "../../core";
import {
  CellText,
  ColumnWidths,
  alignStyle,
  cellClass,
  tableSizing,
} from "./table-cells";

/**
 * A table block's static rendering: a plain `<table>`, each cell's rich text
 * painted by the read-only runs renderer (marks, links, inline chips), each
 * column aligned by its delimiter and drawn at its stored width once one was
 * resized. The read-only surface renders it as the block's `view`; the editable
 * grid (`TableBlock`) shares its cell look (`table-cells.tsx`).
 *
 * Rows and cells carry no identity of their own (they are positions in the
 * stored arrays), so their index IS their key.
 *
 * A table is a `WideBlock`: one with many or long columns grows past the
 * reading column into the pane's free space (centered on the column), so its
 * cells keep a readable width instead of squeezing into narrow strips; past the
 * pane it scrolls sideways on its own.
 *
 * Its cells are `selectableText`, so the words can be selected and copied.
 */
export function TableView({ data }: { data: TableData }) {
  const widths = columnWidths(data);
  const sizing = tableSizing(data, widths);
  const cell = (runs: RichText, col: number, Tag: "th" | "td") => (
    <Tag
      key={col}
      className={cellClass(Tag === "th")}
      style={alignStyle(data.align[col])}
    >
      <CellText runs={runs} />
    </Tag>
  );
  return (
    <TableFrame>
      <table
        {...selectableText}
        className={cn(
          "border-collapse",
          sizing.className,
          textVariantClass("body"),
        )}
        style={sizing.style}
      >
        <ColumnWidths widths={widths} />
        <thead>
          <tr>{data.header.map((runs, col) => cell(runs, col, "th"))}</tr>
        </thead>
        {data.rows.length > 0 ? (
          <tbody>
            {data.rows.map((row, r) => (
              <tr key={r}>{row.map((runs, col) => cell(runs, col, "td"))}</tr>
            ))}
          </tbody>
        ) : null}
      </table>
    </TableFrame>
  );
}

/**
 * The box a table sits in on the page: the block inset, widened past the
 * reading column (`WideBlock`), scrolling sideways past the pane rather than
 * squeezing its cells or pushing the page wide.
 */
function TableFrame({ children }: { children: ReactNode }) {
  return (
    <Inset x={BLOCK_INSET} y="xs">
      <WideBlock>
        <Scroll axis="x">{children}</Scroll>
      </WideBlock>
    </Inset>
  );
}
