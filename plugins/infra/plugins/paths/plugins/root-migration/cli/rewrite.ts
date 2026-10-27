import type { Move } from "./plan";

// The rules that decide what a stored path is and what happens to it — pure,
// shared by the rewrite and by the leftover scan that gates removing the legacy
// name, so the two cannot disagree on what counts.

/**
 * A stored value with every path under a moved prefix pointing at its new
 * home: each `<from>/…` becomes `<to>/…`, and a value that IS `<from>` becomes
 * `<to>`. Text in a file is rewritten wherever the prefix occurs — a file under
 * the root is configuration or state the app reads back (a `spec.json`, a
 * `database.json`, a venv's `pyvenv.cfg`); history is never handed to this
 * (see {@link isHistoryRecord}).
 */
export function rewriteText(text: string, moves: readonly Move[]): string {
  let out = text;
  for (const { from, to } of moves) {
    out = out.replace(pathOccurrences(from), to);
  }
  return out;
}

/**
 * Every occurrence of `from` as a whole path or a path's leading segments:
 * followed by `/`, a quote, whitespace, a separator or the end — never by more
 * of a name (`<from>-clean-install` is another directory).
 */
export function pathOccurrences(from: string): RegExp {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?=[/"'\`\\s:,;)\\]}>]|$)`, "g");
}

/**
 * A database value's new form, or null when it holds no stored path. Only a
 * value that STARTS with a moved prefix is a path; one that mentions it mid-text
 * (a conversation message, a task description, a log line kept in a row) is a
 * record of the past and stays as written — so a prose mention never blocks
 * the scan, and no table has to be listed.
 */
export function rewriteDbValue(
  value: string,
  moves: readonly Move[],
): string | null {
  for (const { from, to } of moves) {
    if (value === from) return to;
    if (value.startsWith(`${from}/`)) return to + value.slice(from.length);
  }
  return null;
}

/**
 * Whether a path relative to the data root is an append-only RECORD of the
 * past rather than something read back as configuration — never rewritten,
 * never counted as a leftover.
 *
 * Not only because a path in history is a fact about then: these files are
 * read by BYTE OFFSET. An agent's `events.jsonl` is tailed from a cursor
 * stored in its conversation's row, a log from its last read position — and
 * the new prefix is shorter than the old, so an in-place rewrite would shift
 * every offset after it and the reader would resume mid-line.
 *
 * - `logs/` — the logs kind;
 * - `state/sdk-agents/` — every agent's launch record, events and log;
 * - `worktrees/<ns>/runs/` — run transcripts;
 * - `*.log`, `*.jsonl` and their numbered rotations, `*.heapsnapshot`, and
 *   LevelDB's own `LOG` / `LOG.old` (inside the browser app's profile).
 */
export function isHistoryRecord(rel: string): boolean {
  const parts = rel.split("/");
  if (parts[0] === "logs") return true;
  if (parts[0] === "state" && parts[1] === "sdk-agents") return true;
  if (parts[0] === "worktrees" && parts[2] === "runs") return true;
  const name = parts.at(-1) ?? "";
  if (name === "LOG" || name === "LOG.old") return true;
  return /\.(?:log|jsonl)(?:\.\d+)?$|\.heapsnapshot$/.test(name);
}

/**
 * Subtrees the file pass never enters: the Postgres cluster (its data is
 * rewritten through SQL, never as bytes) and `deprecated/` (unmanaged leftovers
 * of earlier layouts, kept only to be inspected and deleted by hand).
 */
export function isSkippedTree(rel: string): boolean {
  const top = rel.split("/", 1)[0];
  return top === "postgres" || top === "deprecated";
}

/**
 * The cache entry a path belongs to — `cache/<name>/<entry>` (or `cache/<name>`
 * for a file directly in it) — or null outside `cache/`. A cache is re-derived
 * on demand, so an entry that stores an old path is dropped whole rather than
 * edited: rewriting a built interpreter or a compiled binary in place is not
 * possible, and a half-edited venv is worse than none.
 */
export function cacheEntryOf(rel: string): string | null {
  const parts = rel.split("/");
  if (parts[0] !== "cache" || parts.length < 2) return null;
  return parts.length === 2
    ? parts.slice(0, 2).join("/")
    : parts.slice(0, 3).join("/");
}

/** Whether bytes look like text: no NUL in the first 8 KiB (git's own test). */
export function looksLikeText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 8192).includes(0);
}

/**
 * Claude Code's name for a session's transcript dir: its cwd with every
 * character outside `[A-Za-z0-9]` replaced by `-`.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
