/** One `- [ ]` / `- [x]` line of a `<go>` checklist. */
export interface GoItem {
  text: string;
  /** Pre-checked by the agent (`- [x]`). */
  checked: boolean;
}

/**
 * A `<go>` body: prose around an optional checklist. `lead` is the prose before
 * the first item, `tail` the prose after it (a non-item line between items
 * belongs to the tail too). In a checklist the prose is for the reader only —
 * it is never sent.
 */
export interface GoBody {
  lead: string;
  items: GoItem[];
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
  return m ? { text: m[2]!.trim(), checked: m[1] !== " " } : null;
}

export function parseGo(content: string): GoBody {
  const lead: string[] = [];
  const tail: string[] = [];
  const items: GoItem[] = [];
  for (const line of content.split("\n")) {
    const item = parseGoItem(line);
    if (item) items.push(item);
    else (items.length ? tail : lead).push(line);
  }
  return {
    lead: lead.join("\n").trim(),
    items,
    tail: tail.join("\n").trim(),
  };
}

/**
 * The text the agent receives when the user accepts a `<go>`: the suggestion,
 * wrapped back in `<go>` so the agent reads it as its own words accepted — not
 * as a question the user asked. A checklist keeps ONLY its picked lines, as
 * `- [x]`: the prose around them and the declined items would only cost
 * context (the agent wrote them; they are in its history).
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
