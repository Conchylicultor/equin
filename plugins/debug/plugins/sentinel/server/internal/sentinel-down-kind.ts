import { ReportKind } from "@plugins/reports/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  SENTINEL_DOWN_KIND,
  SentinelDownPayloadSchema,
  type SentinelDownPayload,
} from "../../core";
import type { DownStatus } from "./status-sink";

/** Where the diagnosis of the first known cause lives. */
const DESIGN_DOC =
  "research/2026-09-16-global-sentinel-worker-identity-and-loud-death.md";

// The `sentinel-down` report kind: main gave up respawning the machine watcher.
//
// Until this kind existed, giving up wrote one line to `logs/sentinel.jsonl` and
// nothing else — for a day in September 2026 the watcher crashed on every start,
// the duress latch never tripped, and builds piled onto a machine with ~70 MB
// free while every surface stayed quiet.
//
// Fixed fingerprint: the watcher is one per host and the reports row is keyed
// per worktree (always main here), so a second give-up is the same ongoing
// problem and bumps `count`.
//
// duressExempt: true — a dead watcher is exactly when the box may be in trouble,
// and the report describing the missing guard must not be shed by the guard's
// own machinery (the same argument as `duress-episode`).
export const sentinelDownKind = ReportKind({
  kind: SENTINEL_DOWN_KIND,
  schema: SentinelDownPayloadSchema,
  fingerprint: () => SENTINEL_DOWN_KIND,
  duressExempt: true,
  meta: {
    tag: "[sentinel]",
    notif:
      "The machine watcher stopped — builds are not held back when memory runs out",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = SentinelDownPayloadSchema.parse(row.data);
    return {
      title: `[sentinel] Machine watcher is down after ${String(d.deaths)} failed starts`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: SentinelDownPayload): string {
  const lines: string[] = [];
  lines.push(
    `Main's machine watcher (the cluster sentinel worker thread) died ` +
      `${String(d.deaths)} times right after starting, and main stopped ` +
      `respawning it at ${new Date(d.since).toISOString()}.`,
  );
  lines.push("");
  lines.push(
    "**Why this matters.** The watcher raises the duress latch when the " +
      "machine is struggling (load, memory compression, Postgres pressure). " +
      "While it is down nothing raises it: new builds are not held back and " +
      "observability writes are not shed, however little memory is left.",
  );
  lines.push("");
  lines.push("**What to do:**");
  lines.push(
    "1. Read the worker's errors in main's `sentinel` log channel (Debug → Logs) " +
      "(the last one is below). A death right after spawn is almost always a " +
      "throw while the worker's modules load.",
  );
  lines.push(
    `2. Compare with \`${DESIGN_DOC}\`: the first known cause was a module in ` +
      "the worker's import graph reading the runtime namespace before the " +
      "worker had declared it.",
  );
  lines.push(
    "3. After the fix merges, main rebuilds and restarts the watcher; the " +
      "health report's Machine watcher row turns green.",
  );
  lines.push("");
  lines.push(`**Last error:** ${d.lastError ?? "(the worker reported none)"}`);
  lines.push(`**Deaths:** ${String(d.deaths)}`);
  lines.push(`**Occurrences:** ${String(row.count)}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}

/** File one `sentinel-down` report for a give-up. */
export function reportSentinelDown(status: DownStatus): void {
  // Plain `void`: recordReport runs its own writes in the background lane.
  void recordReport({
    kind: SENTINEL_DOWN_KIND,
    source: "server-duress-monitor",
    data: {
      since: status.since,
      deaths: status.deaths,
      lastError: status.lastError,
    },
    message:
      `machine watcher down after ${String(status.deaths)} failed starts` +
      (status.lastError ? ` — ${status.lastError}` : ""),
  });
}
