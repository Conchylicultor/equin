// Some `type:"user"` turns are not typed by the human — they are harness-relayed
// messages from OTHER Claude sessions, carried in `<teammate-message>` XML blocks.
// These helpers decode the two relay forms (a plain relay, or a relay bundled
// inside a pretty-printed JSON envelope alongside the human's own text) into
// structured TeammateMessage events, leaving the human's genuine text behind.

export interface TeammateMessage {
  teammateId?: string;
  color?: string;
  summary?: string;
  body: string; // inner text, trimmed
}

/** A relay envelope's text always contains one of these two anchors. */
function looksLikeRelayText(text: string): boolean {
  return (
    text.includes("<teammate-message") ||
    text.includes("Another Claude session sent a message")
  );
}

/**
 * Find the index of the `}` that closes the JSON object literal beginning at
 * `start` (which must point at a `{`). String-aware: braces inside JSON string
 * values (and `\"` escapes within them) are ignored. Returns -1 if unbalanced.
 */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Replace each embedded harness relay JSON envelope (a JSON object literal with
 *  a "kind" key and a string "text" key, whose text contains a teammate-message
 *  tag or the "Another Claude session sent a message" preamble) with its decoded
 *  `.text`. Leaves all other text untouched. Handles multiple envelopes. */
export function unwrapRelayEnvelopes(text: string): string {
  let result = text;
  // Re-scan from the start after each splice so newly revealed envelopes (and
  // shifted offsets) are handled. `from` advances past candidates we've decided
  // to leave in place, so a non-envelope `{` can't loop forever.
  let from = 0;
  while (from < result.length) {
    const open = result.indexOf("{", from);
    if (open === -1) break;
    const close = matchBrace(result, open);
    if (close === -1) {
      // Unbalanced from here on — nothing more to match.
      break;
    }
    const slice = result.slice(open, close + 1);
    let decoded: string | null = null;
    try {
      const parsed: unknown = JSON.parse(slice);
      if (
        parsed != null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        "text" in parsed &&
        typeof (parsed as { text: unknown }).text === "string" &&
        looksLikeRelayText((parsed as { text: string }).text)
      ) {
        decoded = (parsed as { text: string }).text;
      }
    } catch (err) {
      // Not valid JSON — this `{` isn't an envelope. This is the one place we
      // intentionally skip a candidate on parse failure (not silencing an error,
      // just classifying the text); re-throw anything that isn't a parse error.
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (decoded !== null) {
      result = result.slice(0, open) + decoded + result.slice(close + 1);
      // Re-scan from the splice point so nested/adjacent envelopes are caught.
      from = open;
    } else {
      from = open + 1;
    }
  }
  return result;
}

/** Extract every <teammate-message ...>...</teammate-message> block into a
 *  TeammateMessage. Returns the parsed messages and the text with those blocks
 *  removed. Parses teammate_id / color / summary from the opening tag's attrs. */
export function extractTeammateMessages(text: string): {
  messages: TeammateMessage[];
  rest: string;
} {
  const blockRe = /<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  const messages: TeammateMessage[] = [];
  let rest = text;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const attrs = m[1]!;
    const body = m[2]!.trim();
    const parsedAttrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrs)) !== null) {
      parsedAttrs[a[1]!] = a[2]!;
    }
    messages.push({
      teammateId: parsedAttrs["teammate_id"],
      color: parsedAttrs["color"],
      summary: parsedAttrs["summary"],
      body,
    });
    rest = rest.replace(m[0], "");
  }
  return { messages, rest };
}

const PREAMBLE = "Another Claude session sent a message:";
const POSTAMBLE_START = "This came from another Claude session";
const LEADING_SEPARATOR_RE = /^\s*-{3,}\s*(?:\n|$)/;
const MULTI_BLANK_RE = /\n{3,}/g;

/** Strip harness relay scaffolding left after extraction: the "Another Claude
 *  session sent a message:" preamble line, the postamble paragraph beginning
 *  "This came from another Claude session" (to end of that paragraph), and any
 *  now-orphaned LEADING separator line of 3+ dashes. Returns the trimmed remainder
 *  (typically the human's genuine text, or empty for a pure relay). */
export function stripRelayBoilerplate(text: string): string {
  let result = text;

  // Remove a line that, trimmed, equals the preamble exactly.
  result = result
    .split("\n")
    .filter((line) => line.trim() !== PREAMBLE)
    .join("\n");

  // Remove the postamble paragraph: from its start to the next blank line, a
  // line of 3+ dashes, or EOF — whichever comes first.
  const postIdx = result.indexOf(POSTAMBLE_START);
  if (postIdx !== -1) {
    const after = result.slice(postIdx);
    const blank = after.search(/\n\s*\n/);
    const dashes = after.search(/\n\s*-{3,}\s*(?:\n|$)/);
    const candidates = [blank, dashes].filter((i) => i !== -1);
    const end = candidates.length > 0 ? Math.min(...candidates) : after.length;
    result = result.slice(0, postIdx) + after.slice(end);
  }

  result = result.trim();

  // Drop a now-orphaned LEADING separator line (the `-----` that divided relay
  // from human text). A `-----` mid-text (a human may type one) is left alone.
  result = result.replace(LEADING_SEPARATOR_RE, "");

  // Collapse runs of 3+ blank lines down to two.
  result = result.replace(MULTI_BLANK_RE, "\n\n");

  return result.trim();
}
