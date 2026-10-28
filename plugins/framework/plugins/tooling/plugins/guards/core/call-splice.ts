import { parseShell, type ShellCall } from "./parse-shell";

/**
 * Rewriting ONE call inside a command string, without re-serialising anything.
 *
 * A rewriting guard knows what it wants to change in terms of a call's argv
 * (`find`'s paths end here, `bun`'s script starts there), but `parseShell`
 * hands it unquoted words with no positions. Rebuilding the command from those
 * words would drop the agent's quoting — `-name '*.ts'` would come back as a
 * glob the shell expands. So the edit is a set of splices into the call's own
 * source text, positioned by re-scanning that text for its words.
 *
 * Every step that cannot be sure says so with `null` rather than guessing, and
 * the result is checked by parsing it again: the caller's `stillOffending` must
 * count one fewer call than before. A guard that gets `null` falls back to what
 * it did before rewriting existed — so a command this cannot model is denied,
 * never mangled.
 */

/** One word of a call's source text: where it sits, and what the shell sees. */
export interface Word {
  start: number;
  end: number;
  /** The word with its quoting removed — comparable to `ShellCall.args`. */
  value: string;
}

/** The call's own words, in its source text's coordinates. */
export interface CallWords {
  name: Word;
  /** One per `ShellCall.args` entry, same order. */
  args: Word[];
}

/** Replace `[from, to)` of the call's source text with `text`. */
export interface Splice {
  from: number;
  to: number;
  text: string;
}

/**
 * Scans `raw` into words, or `null` when it holds anything whose extent this
 * reader does not model — a substitution, a heredoc, a here-string — where a
 * position it reported could be wrong.
 */
function scanWords(raw: string): Word[] | null {
  if (/\$\(|`|<</.test(raw)) return null;
  const words: Word[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (i >= raw.length) break;
    const start = i;
    let value = "";
    while (i < raw.length && !/\s/.test(raw[i]!)) {
      const c = raw[i]!;
      if (c === "'") {
        const close = raw.indexOf("'", i + 1);
        if (close === -1) return null;
        value += raw.slice(i + 1, close);
        i = close + 1;
      } else if (c === '"') {
        let j = i + 1;
        for (; j < raw.length && raw[j] !== '"'; j++) {
          if (raw[j] === "\\" && /["\\$`]/.test(raw[j + 1] ?? "")) j++;
          value += raw[j];
        }
        if (j >= raw.length) return null;
        i = j + 1;
      } else if (c === "\\") {
        value += raw[i + 1] ?? "";
        i += 2;
      } else {
        value += c;
        i++;
      }
    }
    words.push({ start, end: i, value });
  }
  return words;
}

/** `2>/dev/null`, `>out`, `&>log`, `<in` — and the bare operator of `2> x`. */
const REDIRECTION = /^(\d*|&)(>>?|<)(&?\S*)$/;

/**
 * Locates `call`'s name and args among its source text's words: the first
 * word whose basename is the call's name and whose following words — skipping
 * redirections, which `parseShell` lifts out of the argv — are exactly its args.
 */
export function locateCall(call: ShellCall): CallWords | null {
  const words = scanWords(call.raw);
  if (!words) return null;
  for (let k = 0; k < words.length; k++) {
    const head = words[k]!.value.split("/").at(-1);
    if (head !== call.name) continue;
    const args: Word[] = [];
    for (
      let j = k + 1;
      j < words.length && args.length <= call.args.length;
      j++
    ) {
      const w = words[j]!;
      // Read off the SOURCE text: a quoted `'>x'` is an argument, not a redirection.
      const redir = REDIRECTION.exec(call.raw.slice(w.start, w.end));
      if (redir) {
        // A bare operator (`2>`, `>`) takes the next word as its target.
        if (redir[3] === "" || redir[3] === "&") j++;
        continue;
      }
      args.push(w);
    }
    if (
      args.length === call.args.length &&
      args.every((w, idx) => w.value === call.args[idx])
    )
      return { name: words[k]!, args };
  }
  return null;
}

/**
 * Applies `edit` to the first call `isOffending` selects, then the next, until
 * none is left — every offending call, not the first: `find a …; find b …`
 * must not leave `b` unbounded behind a rewritten `a`.
 *
 * Answers the rewritten command, or `null` the moment one call cannot be
 * rewritten with certainty: its text is not found exactly once in the command,
 * its words cannot be located, `edit` declines, or the result still selects as
 * many offending calls as before.
 */
export function rewriteCalls(
  cmd: string,
  baseCwd: string,
  isOffending: (call: ShellCall) => boolean,
  edit: (call: ShellCall, words: CallWords) => Splice[] | null,
): string | null {
  let current = cmd;
  let offending = parseShell(current, baseCwd).calls.filter(isOffending);
  // Each pass removes one offending call; the bound only stops a broken
  // `isOffending` / `edit` pair from looping.
  for (let pass = 0; offending.length > 0 && pass < 16; pass++) {
    const call = offending[0]!;
    const at = current.indexOf(call.raw);
    if (at === -1 || current.indexOf(call.raw, at + 1) !== -1) return null;
    const words = locateCall(call);
    if (!words) return null;
    const splices = edit(call, words);
    if (!splices) return null;
    let raw = call.raw;
    for (const s of [...splices].sort((a, b) => b.from - a.from))
      raw = raw.slice(0, s.from) + s.text + raw.slice(s.to);
    const next =
      current.slice(0, at) + raw + current.slice(at + call.raw.length);
    const left = parseShell(next, baseCwd).calls.filter(isOffending);
    if (left.length >= offending.length) return null;
    current = next;
    offending = left;
  }
  return offending.length === 0 ? current : null;
}
