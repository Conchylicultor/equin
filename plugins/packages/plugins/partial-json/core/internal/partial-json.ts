// A JSON document being written (a model streaming a tool call's input)
// arrives as prefixes. The value a prefix already holds is the longest
// complete-by-construction document it starts: every open container closed,
// an in-progress string VALUE finished where it stands, and an in-progress
// key, number or literal cut back to the last finished value (a number may
// still grow, a key names nothing yet).

type Container = { kind: "object"; expectKey: boolean } | { kind: "array" };

const closerOf = (c: Container) => (c.kind === "object" ? "}" : "]");

/** Ends a number or literal token. */
const DELIMITER = /[,\]}\s]/;

/**
 * The value `prefix` (a prefix of a valid JSON document) already holds, or
 * `undefined` while it holds none (empty, a key in progress, a lone number or
 * literal — which may still grow). A complete object or array parses to
 * itself. A prefix that is not one of a valid
 * document throws — the stream is broken, never guessed around.
 */
export function parsePartialJson(prefix: string): unknown {
  const stack: Container[] = [];
  /** The last cut that closes into a valid document: text up to `at`, then `closers`. */
  const last: { safe: { at: number; closers: string } | null } = { safe: null };
  const markSafe = (at: number) => {
    last.safe = { at, closers: stack.map(closerOf).reverse().join("") };
  };
  const top = (): Container | undefined => stack[stack.length - 1];

  let i = 0;
  while (i < prefix.length) {
    const ch = prefix[i]!;
    if (ch === '"') {
      const t = top();
      const isKey = t?.kind === "object" && t.expectKey;
      const end = stringEnd(prefix, i);
      if (end.kind === "open") {
        // A key in progress names nothing yet; a value is finished where it stands.
        if (isKey) break;
        const body = prefix.slice(0, end.cut);
        const closers = stack.map(closerOf).reverse().join("");
        return JSON.parse(`${body}"${closers}`);
      }
      i = end.after;
      if (!isKey) markSafe(i);
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(
        ch === "{" ? { kind: "object", expectKey: true } : { kind: "array" },
      );
      i++;
      markSafe(i);
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i++;
      markSafe(i);
      continue;
    }
    if (ch === ":") {
      const t = top();
      if (t?.kind === "object") t.expectKey = false;
      i++;
      continue;
    }
    if (ch === ",") {
      const t = top();
      if (t?.kind === "object") t.expectKey = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // A number or literal: finished only once something follows it.
    let j = i + 1;
    while (j < prefix.length && !DELIMITER.test(prefix[j]!)) j++;
    if (j === prefix.length) break;
    i = j;
    markSafe(i);
  }
  const cut = last.safe;
  if (cut === null) return undefined;
  return JSON.parse(prefix.slice(0, cut.at) + cut.closers);
}

/**
 * Where the string opening at `start` ends: just past its closing quote, or —
 * still open — the cut that keeps it valid once a quote is added (before a
 * half-written escape).
 */
function stringEnd(
  text: string,
  start: number,
): { kind: "closed"; after: number } | { kind: "open"; cut: number } {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') return { kind: "closed", after: i + 1 };
    if (ch === "\\") {
      // `\uXXXX` takes four hex digits; every other escape one character.
      const len = text[i + 1] === "u" ? 6 : 2;
      if (i + len > text.length) return { kind: "open", cut: i };
      i += len;
      continue;
    }
    i++;
  }
  return { kind: "open", cut: text.length };
}
