/**
 * One pickable item of a `<go>`: a `- [ ]` / `- [x]` checklist line, or a row
 * of a pick table (its first cell starting `[ ]` / `[x]`).
 */
export interface GoItem {
  /** The line's words — for a table row, its first cell after the mark. */
  text: string;
  /** Pre-checked by the agent (`[x]`). */
  checked: boolean;
  /** A table row's cells after the first; empty for a checklist line. */
  cells: string[];
}

/**
 * A `<go>` body: prose around an optional set of items — a checklist, or the
 * rows of a pick table (`head` is then its header row). `lead` is the prose
 * before the first item, `tail` the prose after it (a non-item line between
 * items belongs to the tail too). The prose is for the reader only — it is
 * never sent, and neither are a row's other cells: a picked row goes back as
 * its first cell, the same `- [x]` line a checklist item does.
 */
export interface GoBody {
  lead: string;
  items: GoItem[];
  /** The pick table's header cells; null when the items are a checklist. */
  head: string[] | null;
  tail: string;
}

// The one spelling of a checklist line's prefix: every reader of a `- [ ]`
// line — the reply's rows, the sent message's boxes, the draft's pick token —
// is built from it.
const BULLET = String.raw`[-*+] `;
const ITEM_RE = new RegExp(String.raw`^\s*${BULLET}\[( |x|X)\] (.*)$`);

/**
 * A picked item's `- [x] ` prefix at a line start — the draft's pick token
 * pattern (global, as the token extension scans with it).
 */
export const GO_PICK_RE = new RegExp(String.raw`^${BULLET}\[[xX]\] `, "g");

/** One line of a `<go>` body as a checklist item, or `null` for prose. */
export function parseGoItem(line: string): GoItem | null {
  const m = ITEM_RE.exec(line);
  return m ? { text: m[2]!.trim(), checked: m[1] !== " ", cells: [] } : null;
}

// A pick table's row mark: the checklist's `[ ]` / `[x]`, leading the first cell.
const CELL_MARK_RE = /^\[( |x|X)\]\s*(.*)$/;
const TABLE_LINE_RE = /^\s*\|/;
const TABLE_RULE_RE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?$/;

/** A GFM table line's cells: split on unescaped pipes, `\|` read as `|`. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * A run of table lines as a pick table — a header, its rule, then rows whose
 * first cell each starts with a mark — or null: any other table is prose.
 */
function parsePickTable(
  lines: string[],
): { head: string[]; items: GoItem[] } | null {
  const [header, rule, ...rows] = lines;
  if (!header || !rule || !TABLE_RULE_RE.test(rule) || rows.length === 0)
    return null;
  const items: GoItem[] = [];
  for (const row of rows) {
    const [first = "", ...cells] = tableCells(row);
    const m = CELL_MARK_RE.exec(first);
    if (!m) return null;
    items.push({ text: m[2]!.trim(), checked: m[1] !== " ", cells });
  }
  return { head: tableCells(header), items };
}

export function parseGo(content: string): GoBody {
  const lead: string[] = [];
  const tail: string[] = [];
  const items: GoItem[] = [];
  let head: string[] | null = null;
  const prose = (line: string) => (items.length ? tail : lead).push(line);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_LINE_RE.test(lines[i]!)) {
      let end = i;
      while (end < lines.length && TABLE_LINE_RE.test(lines[end]!)) end++;
      const run = lines.slice(i, end);
      // One set of items per Go: a table after items is prose.
      const table = items.length ? null : parsePickTable(run);
      if (table) {
        head = table.head;
        items.push(...table.items);
      } else run.forEach(prose);
      i = end - 1;
      continue;
    }
    // A checklist line after a pick table is prose too.
    const item = head ? null : parseGoItem(lines[i]!);
    if (item) items.push(item);
    else prose(lines[i]!);
  }
  return {
    lead: lead.join("\n").trim(),
    items,
    head,
    tail: tail.join("\n").trim(),
  };
}

/**
 * The text the agent receives when the user accepts a `<go>`: the suggestion,
 * wrapped back in `<go>` so the agent reads it as its own words accepted — not
 * as a question the user asked. A checklist keeps ONLY its picked lines, as
 * `- [x]`: the prose around them and the declined items would only cost
 * context (the agent wrote them; they are in its history). A pick table is
 * sent the same way — each picked row as a `- [x]` line of its first cell.
 */
export function goWire(content: string, picked: readonly boolean[]): string {
  const body = parseGo(content);
  if (body.items.length === 0) {
    const text = content.trim();
    return text.includes("\n") ? `<go>\n${text}\n</go>` : `<go>${text}</go>`;
  }
  const lines = body.items
    .filter((_, i) => picked[i])
    .map((item) => `- [x] ${item.text}`);
  return `<go>\n${lines.join("\n")}\n</go>`;
}

/**
 * The draft text ✎ Go inserts for a wire: the same `<go>` region, with the
 * close tag on the region's last line rather than a line of its own — the
 * close marker is invisible, so a `</go>` line would read as an empty line
 * inside the box — and a separator after it, so the caret lands OUTSIDE the
 * region, where an addition is typed.
 */
export function goDraft(wire: string): string {
  return wire.includes("\n")
    ? `${wire.replace(/\n<\/go>$/, "</go>")}\n`
    : `${wire} `;
}
