import { basename, dirname, relative, sep } from "node:path";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import type { HealthData } from "../../core";
import { healthMonitorSeries } from "../../shared/resources";
import { readHealthSeries } from "./read-health-files";

// The pane's fixed read window.
const WINDOW_MS = 2 * 60 * 60 * 1000; // 2h

// The log channels the loader reads, as the files they land in under
// `<worktreesDir>/<wt>/logs/`.
const READ_FILES = new Set([
  "health.jsonl",
  "health-host.jsonl",
  "slow-op-markers.jsonl",
]);

async function loadHealthData(): Promise<HealthData> {
  const { series, hostSamples } = await readHealthSeries(WINDOW_MS);
  return { series, hostSamples, windowMs: WINDOW_MS, readAtMs: Date.now() };
}

/**
 * Does this change move the answer? A worktree directory appearing or going
 * (`<wt>`), or one of the read channels' files in a worktree's logs dir
 * (`<wt>/logs/<channel>.jsonl`) — appended, rotated or removed.
 */
function movesAnswer(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..")) return false;
  const parts = rel.split(sep);
  if (parts.length === 1) return true;
  return (
    parts.length === 3 &&
    basename(dirname(path)) === "logs" &&
    READ_FILES.has(basename(path))
  );
}

/**
 * Notified by the files the loader reads, only while a tab is subscribed: one
 * subtree watch of the worktrees root (through the shared dir hub) hears every
 * backend's `health.jsonl` / `slow-op-markers.jsonl` appends, main's
 * `health-host.jsonl`, and a worktree directory created or reaped.
 *
 * The 2 h window also slides with the clock, but every live backend appends a
 * health sample every 10 s, so the watch fires at least that often while any
 * backend is up — and with none up there is nothing new to show.
 *
 * Throttled to the samplers' own 10 s cadence: dozens of backends each append
 * on their own tick, and each recompute re-reads every worktree's files.
 */
export const healthSeriesServed = serveValue(healthMonitorSeries, {
  source: "external",
  changes: "notified",
  loader: loadHealthData,
  throttleMs: 10_000,
  whileSubscribed: async (_params, notify) => {
    const root = worktreesDir();
    const release = await acquireDirWatch({
      dir: root,
      scope: "subtree",
      onChange: (events) => {
        if (events.some((e) => movesAnswer(root, e.path))) notify();
      },
    });
    // An append between the first load and the watch opening produced no
    // event; one re-read closes that gap.
    notify();
    return release;
  },
});
