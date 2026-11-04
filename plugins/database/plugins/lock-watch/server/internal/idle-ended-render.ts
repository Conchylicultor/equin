import type { ReportRow } from "@plugins/reports/server";
import {
  DB_IDLE_TRANSACTION_ENDED_KIND,
  type DbIdleTransactionEndedPayload,
} from "../../core";
import { clampOneLine } from "./render";

// Everything kind-specific about `db-idle-transaction-ended` that can be said
// without the reports engine: fingerprint, message, investigation task.

const TITLE_MAX = 120;

function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/** Who stalled: the origin, or what little the database says about an untagged session. */
function stalledName(d: DbIdleTransactionEndedPayload): string {
  if (d.origin !== null) return d.origin;
  if (d.pool !== null) return `an untagged statement on pool ${d.pool}`;
  const app =
    d.applicationName !== null && d.applicationName !== ""
      ? ` ${d.applicationName}`
      : "";
  return `untagged session${app}`;
}

/**
 * One row per origin per worktree — the code that stalled is the question, and
 * the same code stalling again is the same question — keyed like the lock
 * watch's `db-lock-holder` rows. Untagged: by the pool the client named, or the
 * `application_name` the watch read; never a pid or a statement, which would
 * mint a row per reap.
 */
export function idleTransactionEndedFingerprint(
  d: DbIdleTransactionEndedPayload,
): string {
  if (d.origin !== null) return `${DB_IDLE_TRANSACTION_ENDED_KIND}:${d.origin}`;
  if (d.pool !== null)
    return `${DB_IDLE_TRANSACTION_ENDED_KIND}:untagged:pool:${d.pool}`;
  return `${DB_IDLE_TRANSACTION_ENDED_KIND}:untagged:${d.applicationName ?? ""}`;
}

export function idleTransactionEndedMessage(
  d: DbIdleTransactionEndedPayload,
): string {
  const idle = d.idleMs !== null ? ` after ${minutes(d.idleMs)} idle` : "";
  return (
    `The database ended ${stalledName(d)}'s transaction${idle} ` +
    `(idle-in-transaction timeout; rolled back): ${clampOneLine(d.sql ?? "?", 200)}`
  );
}

export function renderIdleTransactionEndedTask(
  row: ReportRow,
  d: DbIdleTransactionEndedPayload,
): { title: string; description: string } {
  const bound = d.boundMs !== null ? ` (${minutes(d.boundMs)})` : "";
  const lines: string[] = [];
  lines.push(
    `Postgres ended a session of this worktree's database because it sat idle ` +
      `INSIDE a transaction past the cluster's ` +
      `\`idle_in_transaction_session_timeout\`${bound}: the code that ran its ` +
      `last statement, \`${stalledName(d)}\`, went quiet with the transaction ` +
      "still open. The transaction was rolled back: whatever it wrote is gone, " +
      "and its caller's next statement failed with `IdleTransactionEndedError`.",
  );
  lines.push("");
  lines.push(
    "**Why this matters.** The timeout is a bound, not a fix. Until it fired, " +
      "the transaction held its row locks (every write to those rows failed " +
      "its 60 s deadline), one connection-lane slot, and — if it had written — " +
      "the live-update watermark of every database on the cluster. Something " +
      "in that code waits on something other than the database between two " +
      "statements of a transaction, or is wedged.",
  );
  lines.push("");
  lines.push("**What to do:**");
  lines.push(
    `1. Find the transaction behind \`${stalledName(d)}\`` +
      (d.openedBy !== null && d.openedBy !== d.origin
        ? ` (opened by \`${d.openedBy}\`)`
        : "") +
      " and what it awaits after the statement below: a network call, a file, " +
      "a lock of the app's own, a queue — anything but `tx`. The lock watch " +
      "will have named it before the end: look for `db-lock-holder` rows and " +
      "`[lock-watch]` lines in `db.jsonl` under the same origin.",
  );
  lines.push(
    "2. Move that work out of the transaction (before it, or after the commit " +
      "with `afterCommit`), or make the writes one statement. Never raise the " +
      "timeout to fit it.",
  );
  lines.push("");
  lines.push(`**Last statement:** \`${clampOneLine(d.sql ?? "?", 500)}\``);
  if (d.idleMs !== null) {
    lines.push(
      `**Idle in its transaction:** ${minutes(d.idleMs)}` +
        (d.observedBy === "lock-watch" ? " (at the watch's last look)" : ""),
    );
  }
  if (d.transactionMs !== null) {
    lines.push(`**Transaction open for:** ${minutes(d.transactionMs)}`);
  }
  lines.push(
    `**Seen by:** ${d.observedBy === "client" ? "the session's own client (SQLSTATE 25P03)" : "the lock watch (gone between two looks, ended on a FATAL)"}`,
  );
  if (d.pool !== null) lines.push(`**Pool:** ${d.pool}`);
  if (d.applicationName !== null && d.applicationName !== "") {
    lines.push(`**Application name:** ${d.applicationName}`);
  }
  if (d.pid !== null) lines.push(`**Server pid:** ${d.pid}`);
  lines.push("");
  lines.push(`**Sessions ended so far:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return {
    title: `[db] ${clampOneLine(`${stalledName(d)}: transaction ended by the idle-in-transaction timeout`, TITLE_MAX)}`,
    description: lines.join("\n"),
  };
}
