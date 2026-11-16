import type { FileScan } from "./scan";

// ─── A transcript's identity ───────────────────────────────────────────────────
//
// Claude Code files a session under `<projects>/<dir>/<sessionId>.jsonl` and
// its sub-agents under `<projects>/<dir>/<sessionId>/subagents/…`, where `<dir>`
// is the session's cwd encoded. The dir is NOT part of the transcript's
// identity: it moves when the cwd's name does — the data-root move
// (infra/paths/root-migration) renamed every project dir under the legacy
// data root to its new name, while the rows that had counted those
// files kept the old spelling. Counting by full path then counts the same
// bytes twice (once per spelling). The session id is a UUID, unique on the
// host whatever dir holds it, so the path from the session segment on is the
// transcript: `transcriptKey`.

/** A session segment: `<uuid>` (a session's sub-agent dir) or `<uuid>.jsonl`. */
const SESSION_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.jsonl)?$/;

/**
 * A transcript's identity: its path from the session segment on
 * (`<sessionId>.jsonl`, `<sessionId>/subagents/…/agent-x.jsonl`), the same
 * whichever project dir holds it. A path with no session segment (not a
 * Claude Code transcript) is its own key.
 */
export function transcriptKey(path: string): string {
  const parts = path.split("/");
  const at = parts.findIndex((p) => SESSION_SEGMENT.test(p));
  return at < 1 ? path : parts.slice(at).join("/");
}

/** One conversation's stored file rows, matched to the paths a pass reaches. */
export interface RekeyedRows {
  /** The rows by the path the pass reads them at. */
  byPath: Map<string, FileScan>;
  /**
   * Rows found under another spelling of a reached path: the new path → the
   * row as stored (its old path and the buckets the ledger already holds).
   */
  moved: Map<string, FileScan>;
  /**
   * Rows left over under another spelling of a reached path that already has
   * its own row (both spellings counted): what the ledger must give back.
   */
  dropped: FileScan[];
}

/**
 * Match a conversation's stored file rows to the paths a pass reaches by
 * transcript (`transcriptKey`), not by path: a reached path with no row of its
 * own takes over the one row stored under another spelling of it (so its next
 * read continues from that row's offset instead of counting the file from
 * zero), and a row whose transcript is reached under a path that has its own
 * row (or that another old spelling took first — the furthest read wins) is
 * dropped (counted twice; its tokens go back). A row whose transcript
 * the pass does not reach stays as it is (a vanished file keeps its tokens).
 */
export function rekeyStoredRows(
  stored: ReadonlyMap<string, FileScan>,
  reached: readonly string[],
): RekeyedRows {
  const byPath = new Map(stored);
  const moved = new Map<string, FileScan>();
  const dropped: FileScan[] = [];
  const reachedSet = new Set(reached);
  const reachedByKey = new Map<string, string>();
  for (const path of reached) reachedByKey.set(transcriptKey(path), path);
  // Furthest read first: of two old spellings, the one that read more moves.
  const rows = [...stored.values()].sort((a, b) => b.offset - a.offset);
  for (const row of rows) {
    if (reachedSet.has(row.path)) continue;
    const at = reachedByKey.get(transcriptKey(row.path));
    if (at === undefined) continue;
    byPath.delete(row.path);
    if (byPath.has(at)) {
      dropped.push(row);
      continue;
    }
    byPath.set(at, { ...row, path: at });
    moved.set(at, row);
  }
  return { byPath, moved, dropped };
}
