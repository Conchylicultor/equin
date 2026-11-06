import type { CSSProperties } from "react";
import { plainOf, type RichText } from "@plugins/page/plugins/editor/core";
import { RunsRenderer } from "@plugins/page/plugins/read-only-view/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { columnWidths, type TableAlign, type TableData } from "../../core";

// The cell look both renderings share — the read-only `TableView` and the
// editable grid — so a table reads the same while you edit it. It is the chat
// renderer's table (`primitives/markdown`'s base components), so a table reads
// the same in a conversation and on a page.
const CELL = "border border-border px-sm py-xs align-top whitespace-pre-wrap";

/** A cell's classes: body cells plain, header cells tinted and medium. */
export function cellClass(header: boolean): string {
  return cn(CELL, header && "bg-muted text-left font-medium");
}

/** A column's alignment as the cell's style (its delimiter's colons). */
export function alignStyle(
  align: TableAlign | undefined,
): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}

/**
 * The `<table>`'s sizing: content-sized (filling the column) until a column was
 * resized, then fixed — exactly as wide as its columns, each at its stored
 * width. `widths` overrides the stored ones (a resize in progress).
 */
export function tableSizing(
  data: TableData,
  widths: readonly number[] | null = columnWidths(data),
): { className: string; style?: CSSProperties } {
  if (widths === null) return { className: "w-full" };
  return {
    className: "table-fixed",
    style: { width: widths.reduce((a, b) => a + b, 0) },
  };
}

/** The `<colgroup>` a fixed-width table draws its columns at. */
export function ColumnWidths({ widths }: { widths: readonly number[] | null }) {
  if (widths === null) return null;
  return (
    <colgroup>
      {widths.map((w, c) => (
        // Columns carry no identity beyond their position.
        <col key={c} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

/**
 * A cell's text at rest. An empty cell holds a line break, so it is one line
 * tall — as its editor is (an empty paragraph) — rather than collapsing to its
 * padding.
 */
export function CellText({ runs }: { runs: RichText }) {
  return plainOf(runs) === "" ? <br /> : <RunsRenderer value={runs} />;
}
