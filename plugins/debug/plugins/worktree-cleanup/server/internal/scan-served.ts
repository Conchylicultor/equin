import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  worktreeScan,
  type WorktreeEntry,
  type WorktreeScanMeta,
  type WorktreeScanQuery,
} from "../../shared/scan";
import {
  movedEntryIds,
  produceWorktreeEntries,
  rebuildEntries,
} from "./entries";

/** Rows built between two pushes of a running scan. */
const PUSH_EVERY_ROWS = 50;

interface Scan {
  readonly entries: Map<string, WorktreeEntry>;
  planned: number | null;
  scanned: number;
  complete: boolean;
  failed: unknown;
  /** Push the scan's pages and meta again — a no-op once nobody reads it. */
  push: () => void;
}

/** The scans a subscriber holds, by their question's instant. */
const held = new Map<number, Scan>();

/**
 * Start the scan of every worktree, pushing through `push` as rows are built
 * (every {@link PUSH_EVERY_ROWS}) and once more when it completes or fails. A
 * 1000-row git-status fan-out: off the interactive lane, unprofiled.
 */
function startScan(push: () => void): Scan {
  let sincePush = 0;
  const scan: Scan = {
    entries: new Map(),
    planned: null,
    scanned: 0,
    complete: false,
    failed: undefined,
    push,
  };
  const sink = {
    planned: (more: number) => {
      scan.planned = (scan.planned ?? 0) + more;
      scan.push();
    },
    entry: (entry: WorktreeEntry) => {
      scan.entries.set(entry.attemptId, entry);
      scan.scanned += 1;
      if (++sincePush >= PUSH_EVERY_ROWS) {
        sincePush = 0;
        scan.push();
      }
    },
  };
  void runInBackgroundLane(() =>
    runWithoutProfiling(async () => {
      try {
        await produceWorktreeEntries(sink);
        scan.complete = true;
      } catch (err) {
        // A whole-scan failure (the attempts unreadable): every read rethrows it.
        scan.failed = err;
      }
      scan.push();
    }),
  );
  return scan;
}

/**
 * The held scan `at` names, as it stands — or its failure. The scan is the
 * subscription's (its first subscriber starts it), never a load's, so a read
 * with no subscription behind it fails loud.
 */
function heldScan(at: number): Scan {
  const scan = held.get(at);
  if (scan === undefined)
    throw new Error(
      `no worktree scan is open for ${at} — a scan is read through a subscription, whose first subscriber starts it`,
    );
  if (scan.failed !== undefined) throw scan.failed;
  return scan;
}

/**
 * The worktree scan, external `"notified"`: the truth is the attempts table
 * joined with the disk (each checkout's dir and git status) and the cluster's
 * database list — no change feed sees the disk half — so it is read ONCE per
 * question (the instant `at` it was asked) while a reader holds it: the
 * question's first subscriber starts the scan, and every 50 rows built push
 * its live pages and its meta forward until it completes. After that only a
 * delete moves it: the panel's (`refreshScannedRows`, which re-reads the rows
 * it touched) and the hourly sweep's (`refreshSweptRows`, at its end).
 * Refresh is a new question. Dropped at the last unsubscribe. The loaders only slice the held scan: the attempts / tasks /
 * database-list reads are the scan's, started by the subscription, never by a
 * load.
 */
export const worktreeScanServed = serveValue(worktreeScan, {
  source: "external",
  changes: "notified",
  loader: (q: WorktreeScanQuery, range: LiveKeyRange): WorktreeEntry[] =>
    sliceRange(worktreeScan, [...heldScan(q.at).entries.values()], range),
  meta: (q: WorktreeScanQuery): WorktreeScanMeta => {
    const scan = heldScan(q.at);
    let safe = 0;
    for (const e of scan.entries.values()) if (e.isSafe) safe += 1;
    return {
      planned: scan.planned,
      // While it runs, the rows built so far; once complete, the rows it
      // holds — a delete that removed a dir orphan's row takes it out.
      scanned: scan.complete ? scan.entries.size : scan.scanned,
      complete: scan.complete,
      safe,
    };
  },
  // Once per question, however many of its pages (and its meta) are read.
  whileSubscribed: (q, notify) => {
    const scan = startScan(notify);
    held.set(q.at, scan);
    return () => {
      scan.push = () => {};
      if (held.get(q.at) === scan) held.delete(q.at);
    };
  },
});

/**
 * The ids "Delete N safe" removes: the safe rows of the scan `at` names, which
 * the asking panel holds. Refused while that scan is not held or not complete
 * — the safe set of a partial scan is not the one the panel's count promised.
 */
export function safeIdsOf(at: number): string[] {
  const scan = held.get(at);
  if (scan === undefined)
    throw new HttpError(
      409,
      "This worktree scan is no longer open — refresh and try again.",
    );
  if (!scan.complete)
    throw new HttpError(409, "The worktree scan is still running.");
  return [...scan.entries.values()]
    .filter((e) => e.isSafe)
    .map((e) => e.attemptId);
}

/**
 * Re-read the rows `ids` name in every held scan that lists them, after a
 * delete touched them — an attempt's row is rebuilt (its dir and DB gone), a
 * reaped dir orphan's row leaves — and push each scan that changed. Every
 * delete path ends here: the panel's two (`DELETE /:id`, `POST /bulk-delete`)
 * with the ids they reaped, the hourly sweep (`refreshSweptRows`) with the
 * rows it moved.
 */
export async function refreshScannedRows(
  ids: readonly string[],
): Promise<void> {
  const holding = [...held.values()].filter((s) =>
    ids.some((id) => s.entries.has(id)),
  );
  if (holding.length === 0) return;
  const rebuilt = await rebuildEntries(ids);
  for (const [id, entry] of rebuilt) {
    for (const scan of holding) {
      if (!scan.entries.has(id)) continue;
      if (entry === null) scan.entries.delete(id);
      else scan.entries.set(id, entry);
    }
  }
  for (const scan of holding) scan.push();
}

/**
 * After the hourly sweep: it reaped in its own process, so it cannot name what
 * it reaped to this one — the held scans' rows whose dir or fork DB moved are
 * found by looking (`movedEntryIds`) and re-read like a panel delete's.
 */
export async function refreshSweptRows(): Promise<void> {
  const rows = new Map<string, WorktreeEntry>();
  for (const scan of held.values())
    for (const e of scan.entries.values()) rows.set(e.attemptId, e);
  if (rows.size === 0) return;
  await refreshScannedRows(await movedEntryIds([...rows.values()]));
}
