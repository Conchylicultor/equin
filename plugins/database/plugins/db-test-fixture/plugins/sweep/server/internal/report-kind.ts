import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  LeakedTestDbPayloadSchema,
  type LeakedTestDbPayload,
} from "../../core";

// Re-alert the bell at most once per 6h per suite. A suite whose runs keep
// getting killed is a persistent condition, and the sweep runs hourly — the
// cooldown re-surfaces it periodically without belling once per leaked database.
const NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The `test-database-leaked` report kind: **a test run died, and the sweep just
 * cleaned up after it.**
 *
 * WHY A REPORT AND NOT A LOG LINE. Dropping a database is a destructive act; a
 * destructive act nobody is told about is indistinguishable from data quietly
 * going missing, and a durable line in a JSONL nobody opens is how that goes
 * unnoticed for a week. This sweep DOES the deletion, so it owes a receipt.
 *
 * The report is also the only surviving evidence: the database is gone, and its
 * name (which carried the suite and the pid) went with it.
 *
 * Deduped per `prefix`, because that is the unit anyone acts on — "the
 * page_forest_test suite's runs keep being killed" is one problem, not N.
 *
 * Variant `warning`, not `error`: the sweep working is the system working. What
 * it reveals — a test run being killed rather than finishing — is the thing
 * worth a look, and it may well be a human pressing Ctrl+C, which is fine.
 *
 * NOT `duressExempt`. This is housekeeping, not an outage alarm; if the box is
 * in trouble, shedding this is exactly right — the condition is not urgent and
 * the next sweep re-files it.
 */
export const leakedTestDbKind = ReportKind({
  kind: "test-database-leaked",
  schema: LeakedTestDbPayloadSchema,
  fingerprint: (d: LeakedTestDbPayload) => `test-database-leaked:${d.prefix}`,
  meta: {
    tag: "[db-test-fixture]",
    notif: "A killed test run left a database behind",
    variant: "warning",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = LeakedTestDbPayloadSchema.parse(row.data);
    return {
      title: `[db-test-fixture] ${d.prefix} left a database behind on the cluster`,
      description: render(row, d),
    };
  },
});

function formatMs(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)} days`;
}

function formatBytes(b: number): string {
  return b >= 1 << 30
    ? `${(b / (1 << 30)).toFixed(1)} GB`
    : `${Math.round(b / (1 << 20))} MB`;
}

function render(row: ReportRow, d: LeakedTestDbPayload): string {
  const lines: string[] = [];
  lines.push(
    `The throwaway database \`${d.name}\` was minted by the \`${d.prefix}\` ` +
      `suite (pid ${d.pid}) at ${new Date(d.mintedAt).toISOString()} and was ` +
      `still on the cluster ${formatMs(d.ageMs)} later, holding ` +
      `${formatBytes(d.bytes)}. **The sweep has dropped it.**`,
  );
  lines.push("");
  lines.push(
    "**Nothing is wrong with the fixture.** `createTestDb().drop()` runs in the " +
      "suite's `afterAll`, which reclaims the database on every path the test " +
      "process survives. Reaching this report means the process did NOT survive " +
      "— it was killed before `afterAll` could run.",
  );
  lines.push("");
  lines.push(
    "**So the thing to look at is the test run, not the database.** Ctrl+C on a " +
      "local `./equin test` is a perfectly ordinary cause and needs no " +
      "action. A suite that is being killed repeatedly is not: it usually means " +
      "the suite hangs and someone (or a timeout) is SIGKILLing it, and the " +
      "hang is the real defect.",
  );
  lines.push("");
  lines.push(`**Suite:** \`${d.prefix}\``);
  lines.push(`**Database:** \`${d.name}\` (dropped)`);
  lines.push(`**Minted by pid:** ${d.pid}`);
  lines.push(`**Age at sweep:** ${formatMs(d.ageMs)}`);
  lines.push(`**Reclaimed:** ${formatBytes(d.bytes)}`);
  lines.push("");
  lines.push(
    "The sweep only drops a database that is BOTH past its 6h TTL and has zero " +
      "active connections, so a suite that is merely slow — or paused under a " +
      "debugger — is never touched.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
