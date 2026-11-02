import { type LiveRowResult, useLive } from "@plugins/network/plugins/live/web";
import { runRowKey, runs, type RunRow } from "../../core";

/**
 * One run, by the PAIR that names it — the read every run-detail surface is
 * built on: a point read of the `runs` union (`runs:rows`), live like any
 * row (a running backup's detail updates as its ledger row does).
 *
 * The row is shaped exactly like a listed one (`$columns` included), so a
 * detail pane and a list row read the same arm columns through the same
 * handle. A key naming no registered kind, or no row, is `found: false` — an
 * answer, never a contract error.
 */
export function useRun(ref: {
  kind: string;
  id: string;
}): LiveRowResult<RunRow> {
  return useLive(runs, { id: runRowKey(ref) });
}
