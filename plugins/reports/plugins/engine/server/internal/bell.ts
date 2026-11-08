import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  _reports,
  ReportKind,
  type ReportKindSpec,
} from "@plugins/reports/server";
import {
  formatReportActivity,
  reportActivity,
  reportDetailRoute,
} from "@plugins/reports/core";
import { bellKeyOf, fixNoticeOf } from "./fix-notice";

// A report's bell notification: what one recorded occurrence (or one
// incident) rings, and what a change of a report's standing rings (its
// regression). `record-report.ts` and the fix ledger both ring through here.

// An informational report's glyph; an error / warning draws its variant's.
const infoReportIcon = symbol("info");

// Floor on the bell's re-alert window, and the reason a kind cannot opt out of
// re-alerting. A report IS a problem, and a problem that recurs after you
// dismissed it is news — so "never tell me again" is never the right answer,
// and there is deliberately no spelling for it. `meta.notifCooldownMs` is
// therefore only ever a RAISE above this floor (the engine takes the max),
// exactly the shape `meta.fanOutPerWindow` already has: a kind may ask for a
// LONGER quiet window, never for silence.
const RENOTIFY_FLOOR_MS = 10 * 60 * 1000;

// What ringing a recorded row's bell needs — everything the notification reads.
export interface Bell {
  spec: ReportKindSpec;
  row: typeof _reports.$inferSelect;
  fingerprint: string;
  staleOrigin: boolean;
  clientId: string | null;
  url: string | null;
  buildId: string | null;
}

// The incident a bell rings for, when it stands for more than its own row.
export interface IncidentBell {
  /** Reports filed with it that this one notification stands for. */
  related: number;
  /** How many of the incident's ringing reports were never seen before. */
  fresh: number;
  reportIds: string[];
}

// Ring a recorded row's bell — for itself alone, or for the incident it
// leads. Fire-and-forget: nobody waits on the bell of an occurrence.
export function ringBell(bell: Bell, incident: IncidentBell | null): void {
  void runInBackgroundLane(() =>
    runWithoutProfiling(() => writeBell(bell, incident)),
  );
}

// The bell write itself — awaited by a caller that changes the report's
// standing (`ringRowBell`), fire-and-forget from `ringBell`.
function writeBell(
  bell: Bell,
  incident: IncidentBell | null,
  conn?: NodePgDatabase,
): Promise<string> {
  const { spec, row, staleOrigin, clientId, url, buildId } = bell;
  const fp = bell.fingerprint;
  // Mirror a "[Stale tab]" marker into the bell so the notification itself reads
  // as benign version-skew at a glance.
  const stalePrefix = staleOrigin ? "[Stale tab] " : "";
  // An incident's count leads, so the 140-char clamp below never cuts it.
  const incidentPrefix =
    incident && incident.related > 0
      ? `[+${incident.related} related` +
        (incident.fresh > 0 ? `, ${incident.fresh} new` : "") +
        "] "
      : "";
  const desc = `${stalePrefix}${incidentPrefix}${row.message}`;
  // The bell notification is keyed by the stable report id — one row per
  // fingerprint per EPISODE, updated in place (count, lastSeenAt) while the
  // problem keeps firing. That dedup key is what keeps the bell at one row per
  // distinct problem instead of one per (report × time-bucket). See
  // research/perfs/archive/2026-06-29-notifications-unbounded-resource-root-cause.md.
  //
  // The re-alert policy is the WINDOW, a separate axis from that key: a
  // recurrence after the row went quiet for the window, or after the user
  // dismissed it and it surfaced longer ago than that, files a NEW unread row on
  // top; the earlier row stays where it was, as it was (a notification is never
  // moved or un-dismissed — `shell/notifications`). The window is never zero and
  // never infinite — it is RENOTIFY_FLOOR_MS, which a kind may raise but not
  // lower and not remove. So a crash you dismissed rings again the next time it
  // fires at least 10 minutes later, and a slow op that keeps tripping stays
  // one row whose count grows.
  const resurfaceAfterMs = Math.max(
    RENOTIFY_FLOOR_MS,
    spec.meta.notifCooldownMs ?? 0,
  );
  // The bell write is observability output on the same report path as the
  // `_reports` upsert above — suppress its profiling for the same reasons: its
  // INSERT must never be attributed to whichever loader's ambient context
  // triggered this report (fabricating a `notifications` read-set edge), and a
  // slow notification INSERT must never re-enter the slow-op → report →
  // notification self-feedback loop. The suppression ALS binds the whole detached
  // async chain (AsyncLocalStorage semantics); `void` keeps it fire-and-forget.
  // The background-lane declaration wraps it for the same reason as the `_reports`
  // upsert above — nobody is waiting on this bell write, so it must never take a
  // connection reserved for someone who is
  // (research/2026-07-09-global-interactive-lane-origin-based-db-gating.md).
  //
  // A regressed report rings on its own key (`bellKeyOf`): the regression is a
  // NEW row on top, an error whatever the kind's variant (a fix that did not
  // hold stays until handled), and every later occurrence lands on it.
  const regressed = row.fixState === "regressed";
  return recordNotification(
    {
      type: "report",
      category: "reports",
      icon: spec.meta.variant === "info" && !regressed ? infoReportIcon : null,
      title: staleOrigin ? `${spec.meta.notif} (stale tab)` : spec.meta.notif,
      description: bellDescription(desc),
      variant: regressed ? "error" : spec.meta.variant,
      state: fixNoticeOf(row),
      muted: row.noise,
      // equin's own telemetry: a user not in Developer mode never sees it.
      audience: "developer",
      dedupeKey: bellKeyOf(row),
      resurfaceAfterMs,
      // Deep-link to the report's detail sidepane in Debug → Reports, never a task.
      // Investigation tasks are filed on demand from that pane.
      linkTo: reportDetailRoute.link(debugApp, { reportId: row.id }),
      // Fix: the report's investigate launch (debug/reports' `fix-report`).
      action: { kind: "fix-report", payload: { reportId: row.id } },
      metadata: {
        reportId: row.id,
        source: row.source,
        fingerprint: fp,
        clientId,
        // The raising page, so the bell can name the tab (its app) beside
        // whether it is still open.
        clientUrl: url,
        buildId,
        // Every report the incident filed, this one included.
        ...(incident && { incidentReportIds: incident.reportIds }),
      },
    },
    conn,
  );
}

/**
 * Ring a stored report's bell from the row alone — for a change of the
 * report's standing rather than an occurrence (its regression: the new row on
 * top). The attribution is the row's newest occurrence's.
 */
export function ringRowBell(
  row: typeof _reports.$inferSelect,
  conn?: NodePgDatabase,
): Promise<string> {
  const spec = ReportKind.getContributions().find((k) => k.kind === row.kind);
  if (!spec) {
    throw new Error(
      `ringRowBell: no ReportKind registered for kind "${row.kind}" (report ${row.id})`,
    );
  }
  return runWithoutProfiling(() =>
    writeBell(
      {
        spec,
        row,
        fingerprint: row.fingerprint,
        staleOrigin: row.staleOrigin,
        clientId: row.lastClientId,
        url: row.url,
        buildId: row.lastBuildId,
      },
      null,
      conn,
    ),
  );
}

// The bell's one-line description, clamped — shared with a restated report's
// (`./restate-report`), so the two can never be cut differently.
export function bellDescription(desc: string): string {
  return desc.length > 140 ? `${desc.slice(0, 137)}...` : desc;
}
