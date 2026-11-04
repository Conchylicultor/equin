import type { ReportRow } from "@plugins/reports/server";
import {
  DB_LOCK_HOLDER_KIND,
  describeLockHolder,
  holderName,
  type DbLockHolderPayload,
} from "../../core";
import { CLUSTER_BUSY_MAX, type ClusterActivity } from "./cluster-activity";

// Everything kind-specific that can be said without the reports engine: the
// fingerprint, the message and the investigation task. Testable without
// evaluating the reports plugin's server barrel.

const VISION_DOC = "research/2026-11-04-global-db-connection-failure-vision.md";

const TITLE_MAX = 120;

/** `value` on one line (whitespace folded), cut to `max` with an ellipsis. */
export function clampOneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * One row per origin per worktree: the origin is the code to fix, and the same
 * code holding a transaction open again is the same question. An untagged
 * session (another pool, a psql shell) has no origin: its rows share one per
 * `application_name` — never its statement or pid, which change from one look
 * to the next for a session that is still running, minting a row per minute.
 */
export function lockHolderFingerprint(d: DbLockHolderPayload): string {
  return d.origin !== null
    ? `${DB_LOCK_HOLDER_KIND}:${d.origin}`
    : `${DB_LOCK_HOLDER_KIND}:untagged:${d.applicationName}`;
}

export function lockHolderMessage(d: DbLockHolderPayload): string {
  return `${describeLockHolder(d)}: ${clampOneLine(d.sql, 200)}`;
}

export function renderLockHolderTask(
  row: ReportRow,
  d: DbLockHolderPayload,
): { title: string; description: string } {
  const lines: string[] = [];
  lines.push(
    `The database lock watch saw a session on this worktree's database ` +
      `${d.waiting > 0 ? "holding other sessions back" : "sitting idle inside an open transaction"} ` +
      `for longer than its ${Math.round(d.thresholdMs / 1000)}s bound: ` +
      `${describeLockHolder(d)}.`,
  );
  lines.push("");
  lines.push(
    "**Why this matters.** A transaction holds its row locks until it commits " +
      "or rolls back. On 2026-11-03 one sat idle in its transaction for 5 h; " +
      "every later write to the same rows queued behind it until the " +
      "connection pool was gone and every page hung.",
  );
  lines.push("");
  lines.push("**What to do:**");
  lines.push(
    `1. Find the code behind \`${holderName(d)}\` and why its transaction ` +
      "stays open: an await on something other than the database inside the " +
      "transaction, a connection lost mid-transaction (look for `[deadline]` " +
      "lines in `db.jsonl` under the same origin), or a statement waiting on " +
      "a lock of its own.",
  );
  lines.push(
    "2. Fix that cause. The watch only reports: it never ends a session, " +
      "because ending one hides the code that left it open.",
  );
  lines.push(
    `3. Freeing a wedged database by hand: see the runbook in \`${VISION_DOC}\` ` +
      "(end the whole chain, not just its head).",
  );
  lines.push("");
  lines.push(`**Statement:** \`${clampOneLine(d.sql, 500)}\``);
  lines.push(`**State:** ${d.state ?? "unknown"} (pid ${d.pid})`);
  if (d.applicationName !== "") {
    lines.push(`**Application name:** ${d.applicationName}`);
  }
  if (d.xactMs !== null) {
    lines.push(`**Transaction open for:** ${Math.round(d.xactMs / 1000)}s`);
  }
  lines.push("");
  lines.push(`**Looks that saw it:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return {
    title: `[db] ${clampOneLine(describeLockHolder(d), TITLE_MAX)}`,
    description: lines.join("\n"),
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The `db.jsonl` lines for a look at the cluster taken while a new connection
 * stalled: a headline (how long, how many backends against the cap), then one
 * line per busy backend — which database, what kind, what it waits on, for how
 * long and on what statement.
 */
export function stalledConnectLines(
  stalledMs: number,
  activity: ClusterActivity,
): string[] {
  const listed =
    activity.busy.length >= CLUSTER_BUSY_MAX
      ? `the ${CLUSTER_BUSY_MAX} oldest busy ones`
      : `${activity.busy.length} busy`;
  const lines = [
    `[lock-watch] a new connection got no reply within ${seconds(stalledMs)} ` +
      `while the held session answered; the cluster now: ` +
      `${activity.backends} backends (max_connections ${activity.maxConnections}), ${listed}:`,
  ];
  for (const s of activity.busy) {
    const wait =
      s.waitEventType !== null
        ? `waits on ${s.waitEventType}:${s.waitEvent ?? "?"}`
        : "not waiting";
    const running = s.runningMs !== null ? ` for ${seconds(s.runningMs)}` : "";
    const query = clampOneLine(s.query, 200);
    lines.push(
      `[lock-watch]   pid ${s.pid} ${s.backendType} db=${s.datname ?? "-"} ` +
        `user=${s.usename ?? "-"} ${s.state ?? "no state"}, ${wait}${running}` +
        (query !== "" ? ` — ${query}` : ""),
    );
  }
  return lines;
}
