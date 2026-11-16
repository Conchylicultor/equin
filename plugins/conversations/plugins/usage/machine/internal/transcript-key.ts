import type { FileScan } from "./scan";

// ─── A transcript's identity ───────────────────────────────────────────────────
//
// Claude Code files a session under `<projects>/<dir>/<sessionId>.jsonl` and
// its sub-agents under `<projects>/<dir>/<sessionId>/subagents/…`, where `<dir>`
// is the session's cwd encoded. The dir is NOT part of the transcript's
// identity: it moves when the cwd's name does — the data-root move
// (infra/paths/root-migration) renamed every project dir under the legacy
// data root to its new name, while the rows that had counted those
// files kept the old spelling, and counting by full path then counted the
// same bytes twice (once per spelling). The session id is a UUID, unique on
// the host whatever dir holds it, so the path from the session segment on is
// the transcript: `transcriptKey`.
//
// That key is also what the scan tables STORE (`conversation_usage_files.path`,
// `claude_transcript_scans.path`) — never the absolute path — so renaming a
// project dir (or the projects dir itself) leaves every row valid. The scanners
// read files by their full path and store `transcriptKey(path)`.

/** A session segment: `<uuid>` (a session's sub-agent dir) or `<uuid>.jsonl`. */
const SESSION_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.jsonl)?$/;

/**
 * A transcript's identity: its path from the session segment on
 * (`<sessionId>.jsonl`, `<sessionId>/subagents/…/agent-x.jsonl`), the same
 * whichever project dir holds it — and the form the scan tables store. A key
 * is its own key; a path with no session segment (not a Claude Code
 * transcript) is its own key.
 */
export function transcriptKey(path: string): string {
  const parts = path.split("/");
  const at = parts.findIndex((p) => SESSION_SEGMENT.test(p));
  return at < 1 ? path : parts.slice(at).join("/");
}

/** One conversation's stored file rows, matched to the paths a pass reaches. */
export interface RekeyedRows {
  /**
   * Every transcript's one row: under the full path the pass reads it at when
   * reached (the row's `path` set to it), else under its key.
   */
  byPath: Map<string, FileScan>;
  /**
   * Rows stored under a spelling that is not their key (an absolute path,
   * written before the tables stored keys): `byPath`'s entry → the row as
   * stored. Each is rewritten under its key, its old row deleted.
   */
  moved: Map<string, FileScan>;
  /**
   * Second rows of a transcript that already has one, read less far: the
   * same count continued under another spelling (an older backend advancing
   * the absolute row it held), deleted with nothing given back.
   */
  dropped: FileScan[];
}

/**
 * Match a conversation's stored file rows to the paths a pass reaches by
 * transcript (`transcriptKey`): one row per transcript — the one read
 * furthest (a tie: the one already stored under its key, so nothing moves) —
 * found under the reached path of the same key, so its next read continues
 * from its offset instead of counting the file again from zero. A row whose
 * transcript the pass does not reach stays, under its key (a vanished file
 * keeps its tokens).
 */
export function rekeyStoredRows(
  stored: Iterable<FileScan>,
  reached: readonly string[],
): RekeyedRows {
  const byPath = new Map<string, FileScan>();
  const moved = new Map<string, FileScan>();
  const dropped: FileScan[] = [];
  const reachedByKey = new Map<string, string>();
  for (const path of reached) reachedByKey.set(transcriptKey(path), path);
  const isKeyed = (row: FileScan): number =>
    transcriptKey(row.path) === row.path ? 1 : 0;
  const rows = [...stored].sort(
    (a, b) =>
      b.offset - a.offset ||
      isKeyed(b) - isKeyed(a) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  for (const row of rows) {
    const key = transcriptKey(row.path);
    const at = reachedByKey.get(key) ?? key;
    if (byPath.has(at)) {
      dropped.push(row);
      continue;
    }
    byPath.set(at, { ...row, path: at });
    if (row.path !== key) moved.set(at, row);
  }
  return { byPath, moved, dropped };
}
