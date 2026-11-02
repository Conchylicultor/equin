import type { CSSProperties } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";
import { BLOCK_INSET } from "@plugins/page/plugins/editor/web";
import type { RichText } from "@plugins/page/plugins/editor/core";
import { RunsRenderer } from "@plugins/page/plugins/read-only-view/web";
import type { TableAlign, TableData } from "../../core";

// The chat renderer's table (`primitives/markdown`'s base components), so a
// table reads the same in a conversation and on a page. Its `my-flow-block` rhythm
// is the page's `Inset y` here instead.
const CELL = "border border-border px-sm py-xs align-top whitespace-pre-wrap";

function alignStyle(align: TableAlign | undefined): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}

/**
 * A table block's static rendering: a plain `<table>`, each cell's rich text
 * painted by the read-only runs renderer (marks, links, inline chips) and each
 * column aligned by its delimiter. Pure — the editable block wraps it with its
 * own chrome, and the read-only surface renders it as the block's `view`.
 *
 * Rows and cells carry no identity of their own (they are positions in the
 * stored arrays), so their index IS their key.
 */
export function TableView({ data }: { data: TableData }) {
  const cell = (runs: RichText, col: number, Tag: "th" | "td") => (
    <Tag
      key={col}
      className={cn(CELL, Tag === "th" && "bg-muted text-left font-medium")}
      style={alignStyle(data.align[col])}
    >
      <RunsRenderer value={runs} />
    </Tag>
  );
  return (
    <Inset x={BLOCK_INSET} y="xs">
      {/* A table wider than the column scrolls sideways rather than squeezing
          its cells or pushing the page wide. */}
      <Scroll axis="x">
        <table
          className={cn("w-full border-collapse", textVariantClass("body"))}
        >
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
      </Scroll>
    </Inset>
  );
}
