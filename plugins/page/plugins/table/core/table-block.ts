import { z } from "zod";
import {
  defineBlock,
  RichTextSchema,
  type MdParseCtx,
  type RichText,
} from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { typeVar } from "@plugins/primitives/plugins/css/plugins/text/core";
import {
  delimiterCell,
  escapeCell,
  fitRow,
  formatRow,
  parseDelimiterRow,
  splitRow,
  unescapeCell,
  type Align,
} from "./gfm-table";

const tableIcon = symbol("table");

/** One column's alignment: `null` states none (a plain `---` delimiter). */
export type TableAlign = Align;

const TableAlignSchema = z.enum(["left", "center", "right"]).nullable();

// Text-less (no `text` key), so the payload is data only: the cells are rich
// text runs held in `data`, not a content doc. Every row and the alignment list
// are exactly as wide as the header — the `refine` below, since a zod object
// refinement would turn the schema into a `ZodEffects` with no `.shape`.
const tableSchema = z.object({
  align: z.array(TableAlignSchema),
  header: z.array(RichTextSchema),
  rows: z.array(z.array(RichTextSchema)),
});

export type TableData = z.infer<typeof tableSchema>;

/** A row line matches when it opens with a pipe — GFM's leading-pipe form. */
const ROW_LINE = /^\|/;

/** The cells of one row line, fitted to `width`, each read back as runs. */
function rowCells(line: string, width: number, ctx: MdParseCtx): RichText[] {
  return fitRow(splitRow(line, ctx.protectedSpans), width).map((raw) =>
    ctx.runs(unescapeCell(raw, ctx.protectedSpans)),
  );
}

/**
 * Does `lines[k]` START a table — is it followed by a delimiter row as wide as
 * itself? A table has no closing line, and our dialect puts nothing between two
 * sibling blocks, so this is the one thing that tells the first row of the next
 * table from one more body row of this one. (The serializer escapes any cell
 * that reads as a delimiter cell, so a body row it wrote is never mistaken for
 * a delimiter row.)
 */
function startsTable(
  lines: readonly string[],
  k: number,
  ctx: MdParseCtx,
): boolean {
  const next = lines[k + 1];
  if (next === undefined) return false;
  const aligns = parseDelimiterRow(next, ctx.protectedSpans);
  return (
    aligns !== null &&
    aligns.length === splitRow(lines[k]!, ctx.protectedSpans).length
  );
}

export const tableBlock = defineBlock({
  type: "table",
  schema: tableSchema,
  refine(data, ctx) {
    const width = data.header.length;
    if (width < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["header"],
        message: "A table has at least one column.",
      });
    }
    if (data.align.length !== width) {
      ctx.addIssue({
        code: "custom",
        path: ["align"],
        message: `align has ${data.align.length} entries for ${width} column(s).`,
      });
    }
    data.rows.forEach((row, i) => {
      if (row.length !== width) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", i],
          message: `row ${i} has ${row.length} cell(s) for ${width} column(s).`,
        });
      }
    });
  },
  // Not a doc-text block: the header row's text sits below the view's
  // `Inset y="xs"`, the table's 1px top border and the cell's `py-xs`, on the
  // UI `body` line — so seat the rail on the header row.
  gutterFirstLineCenter: `calc(var(--space-xs) * 2 + 1px + ${typeVar("line-height-body")} / 2)`,
  label: "Table",
  icon: tableIcon,
  aliases: ["grid", "gfm", "columns"],
  empty: () => ({
    align: [null, null],
    header: [[], []],
    rows: [
      [[], []],
      [[], []],
    ],
  }),
  // No `typingPrefixes`: `| ` is the quote's typing prefix, and a table is
  // built from the insert menu (or a paste), never from a keystroke.
  //
  // GFM pipe table, one row per line. A table has no closing delimiter, so it
  // is a `lineRun` rather than a `parseLine` (one line) or a `fence`
  // (open…close): every line of the run opens with `|`, and `parse` decides how
  // many of them are this table.
  markdown: {
    serialize: (d, ctx) => {
      const cell = (runs: RichText): string =>
        escapeCell(ctx.mdLine(runs), ctx.protectedSpans);
      return [
        formatRow(d.header.map(cell)),
        formatRow(d.align.map(delimiterCell)),
        ...d.rows.map((row) => formatRow(row.map(cell))),
      ].join("\n");
    },
    lineRun: {
      claims: ["| a | b |"],
      matches: (line) => ROW_LINE.test(line),
      parse: (lines, ctx) => {
        // A header, then a delimiter row exactly as wide — otherwise this is
        // not a table, and the first line falls to prose.
        if (lines.length < 2) return null;
        const width = splitRow(lines[0]!, ctx.protectedSpans).length;
        const align = parseDelimiterRow(lines[1]!, ctx.protectedSpans);
        if (align === null || align.length !== width) return null;
        const rows: RichText[][] = [];
        let k = 2;
        // Body rows run to the end of the run, or to the first line that starts
        // the NEXT table. Ragged rows are padded / truncated to the header's
        // width, as GFM reads them — canonical after one round trip.
        while (k < lines.length && !startsTable(lines, k, ctx)) {
          rows.push(rowCells(lines[k]!, width, ctx));
          k++;
        }
        return {
          data: { align, header: rowCells(lines[0]!, width, ctx), rows },
          consumed: k,
        };
      },
    },
  },
});
