import { z } from "zod";
import {
  coalesce,
  plainOf,
  RichTextSchema,
  type Mark,
  type RichText,
  type TextRun,
} from "@plugins/page/plugins/editor/core";

// A range of cells on the clipboard, in three flavours written together, so
// it pastes as cells wherever cells are understood:
//
// - `CELLS_MIME` — the cells' rich text exactly, for a paste into a page table
//   (this one or another, in any tab);
// - `text/html` — a `<table>`, which spreadsheets (Google Sheets, Excel,
//   Numbers) and rich editors read as a grid, marks and links included;
// - `text/plain` — tab-separated values, the spreadsheets' own plain-text
//   grid: a cell holding a tab, a line break or a quote is quoted, its quotes
//   doubled.
//
// Reading takes the richest flavour present. A paste is a rectangle — every
// row as wide as the widest — so `pasteCells` can place it.

/** The page table's own clipboard flavour: the copied cells' runs. */
export const CELLS_MIME = "application/x-equin-table-cells";

const CellsPayloadSchema = z.object({
  cells: z.array(z.array(RichTextSchema)),
});

/** Where a pasted grid was read from. */
export type CellsSource = "cells" | "html" | "text";

export interface PastedCells {
  cells: RichText[][];
  source: CellsSource;
}

export function writeCells(dt: DataTransfer, cells: RichText[][]): void {
  dt.setData(
    CELLS_MIME,
    JSON.stringify({ cells } satisfies z.infer<typeof CellsPayloadSchema>),
  );
  dt.setData("text/html", cellsToHtml(cells));
  dt.setData("text/plain", cellsToTsv(cells));
}

/**
 * The grid a clipboard holds, from its richest flavour, or `null` when it holds
 * none of them (or only empty text). A `CELLS_MIME` payload that does not
 * parse is a loud error — it is ours, so it is a bug, not a foreign format.
 */
export function readCells(dt: DataTransfer): PastedCells | null {
  const own = dt.getData(CELLS_MIME);
  if (own) {
    const { cells } = CellsPayloadSchema.parse(JSON.parse(own));
    return rectangle(cells, "cells");
  }
  const html = dt.getData("text/html");
  if (html) {
    const cells = htmlTableCells(html);
    if (cells) return rectangle(cells, "html");
  }
  const text = dt.getData("text/plain");
  if (text) return rectangle(tsvToCells(text), "text");
  return null;
}

/**
 * Is this paste a GRID — several cells — rather than text for one cell? What
 * a paste into an open cell asks: a range of cells (ours, or a spreadsheet's
 * table) spreads across the table; text, even several lines of it, stays in
 * the cell unless it has a tab (a spreadsheet's plain-text grid).
 */
export function isCellGrid(pasted: PastedCells, dt: DataTransfer): boolean {
  const many = pasted.cells.length > 1 || (pasted.cells[0]?.length ?? 0) > 1;
  if (!many) return false;
  return pasted.source !== "text" || dt.getData("text/plain").includes("\t");
}

function rectangle(
  cells: RichText[][],
  source: CellsSource,
): PastedCells | null {
  const width = Math.max(0, ...cells.map((row) => row.length));
  if (cells.length === 0 || width === 0) return null;
  return {
    cells: cells.map((row) => [
      ...row,
      ...Array.from({ length: width - row.length }, (): RichText => []),
    ]),
    source,
  };
}

// ── text/plain: tab-separated values ─────────────────────────────────────────

/** A cell's plain text, quoted when it holds a tab, a line break or a quote. */
function tsvField(runs: RichText): string {
  const text = plainOf(runs);
  return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function cellsToTsv(cells: RichText[][]): string {
  return cells.map((row) => row.map(tsvField).join("\t")).join("\n");
}

/**
 * Tab-separated values as cells, as spreadsheets write them: rows end at a line
 * break (`\r\n` or `\n`; a final one ends the last row rather than starting an
 * empty one), cells at a tab, and a field opening with `"` runs to its closing
 * quote, `""` inside it being one quote — so it may hold tabs and line breaks.
 */
export function tsvToCells(text: string): RichText[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' && field === "") {
      // A quoted field: to the closing quote, `""` an escaped one.
      let j = i + 1;
      let quoted = "";
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            quoted += '"';
            j += 2;
            continue;
          }
          break;
        }
        quoted += text[j];
        j++;
      }
      if (j >= text.length) {
        // No closing quote: not a quoted field after all, a literal quote.
        field += ch;
        i++;
        continue;
      }
      field = quoted;
      i = j + 1;
      continue;
    }
    if (ch === "\t") {
      endField();
      i++;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  // A final line break ended the last row; anything after it is one more.
  if (field !== "" || row.length > 0) endRow();
  return rows.map((cells) =>
    cells.map((cell) => {
      const text = cell.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      return text ? [{ text }] : [];
    }),
  );
}

// ── text/html: a <table> ─────────────────────────────────────────────────────

const MARK_TAGS: Record<Mark, string> = {
  bold: "b",
  italic: "i",
  underline: "u",
  strikethrough: "s",
  code: "code",
};

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function runToHtml(run: TextRun): string {
  let html = escapeHtml(run.text).replaceAll("\n", "<br>");
  for (const mark of run.marks ?? []) {
    const tag = MARK_TAGS[mark];
    html = `<${tag}>${html}</${tag}>`;
  }
  return run.link ? `<a href="${escapeHtml(run.link)}">${html}</a>` : html;
}

export function cellsToHtml(cells: RichText[][]): string {
  const rows = cells
    .map(
      (row) =>
        `<tr>${row.map((runs) => `<td>${runs.map(runToHtml).join("")}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<meta charset="utf-8"><table><tbody>${rows}</tbody></table>`;
}

const TAG_MARKS: Record<string, Mark> = {
  B: "bold",
  STRONG: "bold",
  I: "italic",
  EM: "italic",
  U: "underline",
  S: "strikethrough",
  DEL: "strikethrough",
  STRIKE: "strikethrough",
  CODE: "code",
};

/** Elements whose content starts on a line of its own. */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

/**
 * The first `<table>` in a clipboard's HTML as cells, or `null` when it has
 * none. A spanned cell (`colspan`) is followed by empty cells, so the columns
 * after it stay aligned.
 */
export function htmlTableCells(html: string): RichText[][] | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  return Array.from(table.rows).map((tr) =>
    Array.from(tr.cells).flatMap((cell) => [
      cellRuns(cell),
      ...Array.from(
        { length: Math.max(0, cell.colSpan - 1) },
        (): RichText => [],
      ),
    ]),
  );
}

/** One HTML cell's content as runs: its marks, links and line breaks. */
function cellRuns(cell: Element): RichText {
  const runs: TextRun[] = [];
  const walk = (node: Node, marks: Mark[], link: string | undefined) => {
    if (node.nodeType === node.TEXT_NODE) {
      // Source formatting is not content: whitespace collapses, as it renders.
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (text) {
        runs.push({
          text,
          ...(marks.length ? { marks: [...new Set(marks)] } : {}),
          ...(link ? { link } : {}),
        });
      }
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      runs.push({ text: "\n" });
      return;
    }
    if (BLOCK_TAGS.has(node.tagName) && runs.length > 0) {
      runs.push({ text: "\n" });
    }
    const mark = TAG_MARKS[node.tagName];
    const href = node.tagName === "A" ? node.getAttribute("href") : null;
    for (const child of Array.from(node.childNodes)) {
      walk(child, mark ? [...marks, mark] : marks, href ?? link);
    }
  };
  for (const child of Array.from(cell.childNodes)) walk(child, [], undefined);
  return trimRuns(coalesce(runs));
}

/** Runs without the blank space at either end (GFM trims a cell too). */
function trimRuns(runs: RichText): RichText {
  const out = runs.map((r) => ({ ...r }));
  while (out.length > 0) {
    const first = out[0]!;
    first.text = first.text.replace(/^[ \n]+/, "");
    if (first.text) break;
    out.shift();
  }
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    last.text = last.text.replace(/[ \n]+$/, "");
    if (last.text) break;
    out.pop();
  }
  return out;
}
