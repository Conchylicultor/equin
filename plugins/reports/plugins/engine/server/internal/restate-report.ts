import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { ProducerExecutor } from "@plugins/network/plugins/live/plugins/change-feed/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { restateNotification } from "@plugins/shell/plugins/notifications/server";
import { _reports, ReportKind } from "@plugins/reports/server";
import { reportIdKind } from "@plugins/reports/core";
import { reportsProducer } from "./producer";
import { bellDescription, clamp, MESSAGE_MAX } from "./record-report";

/** One occurrence of a report, told again now that more is known about it. */
export interface RestateOccurrence {
  /** The row `recordReport` answered (`RecordReportResult.reportId`). */
  reportId: string;
  /** The kind the caller filed it as — a restate never crosses kinds. */
  kind: string;
  /** The occurrence's own instant (epoch ms), as `recordReport` stamped it
   * (`ReportInput.occurredAt`). */
  occurredAt: number;
  message: string;
  /** The kind's payload for that occurrence, validated by its schema. */
  data: Record<string, unknown>;
}

/**
 * What became of a restate:
 * - `restated` — the occurrence now says `message`. `newest`: it was the row's
 *   latest occurrence, so the row's own message and data (and its bell's
 *   line) say it too; an older one is restated in `recent` only, under the
 *   newer occurrences that have since replaced the row's words.
 * - `aged-out` — the row no longer keeps the occurrence (older than the
 *   newest `REPORT_RECENT_MAX`): nothing left that says it.
 * - `gone` — no such row of this kind (retention swept it).
 */
export type RestateResult =
  | { outcome: "restated"; newest: boolean }
  | { outcome: "aged-out" }
  | { outcome: "gone" };

/**
 * Restate one occurrence of a report: rewrite what it SAYS — its message, and,
 * when it is the row's newest occurrence, the row's message, data and bell
 * line — without it counting as another occurrence. `count`, the seen-at
 * times, the noise / stale flags, the linked task and the bell's read /
 * dismissed state are untouched, and nothing rings: it is the same event, not
 * a recurrence.
 *
 * For a kind whose occurrence has a sequel the filer learns later (a job
 * attempt that failed, then its run recovered or gave up): the report is filed
 * at once, as itself, and restated when the sequel is known — never delayed,
 * suppressed or downgraded to wait for it.
 *
 * Only the serving backend writes `reports` (the producer throws elsewhere).
 */
export async function restateReportOccurrence(
  r: RestateOccurrence,
): Promise<RestateResult> {
  const spec = ReportKind.getContributions().find((k) => k.kind === r.kind);
  if (!spec) {
    throw new Error(
      `restateReportOccurrence: no ReportKind registered for kind "${r.kind}"`,
    );
  }
  spec.schema.parse(r.data);
  const restated = { ...r, message: clamp(r.message, MESSAGE_MAX) };

  // Background lane and no profiling, as `recordReport`'s own writes: nobody
  // waits on it, and a report write must not feed the slow-op recorder.
  const [row] = await runInBackgroundLane(() =>
    runWithoutProfiling(async () => await writeRestate(restated)),
  );
  if (!row) return { outcome: "gone" };

  const newest = row.lastSeenAt.getTime() === r.occurredAt;
  if (!newest && !row.recent.some((o) => o.at === r.occurredAt)) {
    return { outcome: "aged-out" };
  }
  if (newest) {
    // The bell holding this report's key says what the row says now; the
    // same stale-tab marker `recordReport` gives it.
    const stalePrefix = row.staleOrigin ? "[Stale tab] " : "";
    await runInBackgroundLane(() =>
      runWithoutProfiling(() =>
        restateNotification(row.id, {
          description: bellDescription(`${stalePrefix}${row.message}`),
        }),
      ),
    );
  }
  return { outcome: "restated", newest };
}

/**
 * The restate's one statement, through the reports producer: the
 * occurrence's `recent` entry (matched by its instant) gets the new message in
 * place — every other entry, and the order, kept — and the row's message and
 * data follow only when it is the newest occurrence. Count, seen-at times and
 * flags are not in the SET. Executor-parametrized for the DB-backed suite,
 * the `writeReport` precedent; `message` arrives clamped.
 */
export async function writeRestate(
  r: RestateOccurrence,
  executor: ProducerExecutor = db,
): Promise<(typeof _reports.$inferSelect)[]> {
  const occurredAt = new Date(r.occurredAt);
  return await reportsProducer.mutate(
    executor,
    (q, t) => {
      const isNewest = sql`${t.lastSeenAt} = ${occurredAt}`;
      const recent = sql`(
        select coalesce(
          jsonb_agg(
            case when (o->>'at')::bigint = ${r.occurredAt}
              then jsonb_set(o, '{message}', to_jsonb(${r.message}::text))
              else o end
            order by ord
          ),
          '[]'::jsonb
        )
        from jsonb_array_elements(${t.recent}) with ordinality as e(o, ord)
      )`;
      return q
        .update(t)
        .set({
          recent,
          message: sql`case when ${isNewest} then ${r.message} else ${t.message} end`,
          data: sql`case when ${isNewest} then ${JSON.stringify(r.data)}::jsonb else ${t.data} end`,
        })
        .where(and(eq(t.id, reportIdKind.key(r.reportId)), eq(t.kind, r.kind)));
    },
    { latency: "background", returning: getTableColumns(_reports) },
  );
}
