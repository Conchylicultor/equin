import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { getTableColumns, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type {
  ProducerBuilder,
  ProducerExecutor,
} from "@plugins/database/plugins/change-feed/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { getServerGraphHash } from "@plugins/build/plugins/server-build-id/server";
import {
  createShedBuffer,
  type ShedSummary,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/shed/server";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { reportsProducer } from "./producer";
import { bumpWindowAndCheck } from "./velocity";
import { isNoiseReport } from "./noise";
import {
  _reports,
  ReportKind,
  reportRecordedSignal,
} from "@plugins/reports/server";
import { createFanOutGate, type StormSummary } from "./fan-out";
import {
  reportDetailRoute,
  reportIdKind,
  type ReportId,
  type ReportInput,
} from "@plugins/reports/core";

// What became of one recordReport call. A discriminated union so "the engine
// took ownership of this occurrence" can never be misread as "recorded, with
// no limit applied" — which is exactly what the old `{reportId: null,
// rateLimited: false}` shed result said, untruthfully.
export type RecordReportResult =
  // The report landed on a `_reports` row (new or deduped onto an existing
  // fingerprint). `rateLimited` says the bell was skipped for this occurrence.
  | {
      outcome: "recorded";
      reportId: string;
      taskId: string | null;
      rateLimited: boolean;
    }
  // Buffered by the duress shed engine; it replays through this same path
  // after the episode clears.
  | { outcome: "shed" }
  // Folded into a fan-out storm rollup: no row, no notification. `stormKind`
  // is the kind of the rollup report that accounts for it.
  | { outcome: "collapsed"; stormKind: string };

// The generic one-line summary is unbounded (an aggregated error can be hundreds
// of KB). Clamp it at the ingestion boundary so nothing downstream — the row,
// the notification, the task title — can ever exceed this. Kind-specific payload
// (stack, etc.) is clamped by the kind's renderTask when it builds the task
// description, where the ballooning actually hurt (markdown render).
const MESSAGE_MAX = 4_000;

// Truncate the middle, keeping head + tail. The closing context of an aggregated
// error matters as much as the opening, so we drop the redundant middle.
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const omitted = value.length - max;
  return `${value.slice(0, head)}\n… [truncated ${omitted} chars] …\n${value.slice(value.length - tail)}`;
}

// The noise pipeline classifies on a small, generic shape. Crash-shaped fields
// (errorType / stack) that noise rules inspect live in the kind's `data` payload;
// we surface them here as plain strings if present. A kind that has no such
// fields simply yields nulls and matches no crash-specific noise rule.
function noiseFieldsFrom(data: Record<string, unknown>): {
  errorType: string | null;
  stack: string | null;
} {
  const errorType = typeof data.errorType === "string" ? data.errorType : null;
  const stack = typeof data.stack === "string" ? data.stack : null;
  return { errorType, stack };
}

function shedSummaryMessage(s: ShedSummary): string {
  const shed = Object.values(s.byCascade).reduce((a, c) => a + c.shed, 0);
  const dropped = Object.values(s.byCascade).reduce((a, c) => a + c.dropped, 0);
  return (
    `duress episode cleared: ${s.kind} buffer shed ${shed} + dropped ${dropped} ` +
    `across ${Object.keys(s.byCascade).length} cascade keys ` +
    `(${s.replayed} replayed, ${s.replayErrors} replay errors)`
  );
}

// Duress shed gate for the report durable path (Phase C2). During a host
// duress episode, past the first-N-per-fingerprint grant the validated input
// is buffered (with its fingerprint as the cascade key — the same axis the
// upsert dedupes on) and the durable path below is skipped; after the episode
// clears, replay re-drives recordReport per item, where the fingerprint upsert
// dedupes and `count` accumulates truthfully.
//
// Why the accounting can't eat itself: the flush timer only fires when the
// latch reads clear, but a flush is not atomic — duress can RE-TRIP while the
// replay chunks and the trailing summary run. Replayed items simply re-enter
// this gate and are re-buffered under the new episode (deferred again, never
// lost). The flush SUMMARY, however, is the only record of what was
// shed/dropped — if it were re-shed it could be dropped on buffer overflow and
// the accounting silently lost. So the duress-shed kind declares itself
// `duressExempt` (see ReportKindSpec) and bypasses the gate; "flush only
// happens after clear" alone would not close that race.
const reportShed = createShedBuffer<{
  input: ReportInput;
  fingerprint: string;
}>({
  kind: "reports",
  cascadeKeyOf: (item) => item.fingerprint,
  replay: async (items) => {
    for (const item of items) await recordReport(item.input);
  },
  onFlushSummary: (s) => {
    void recordReport({
      kind: "duress-shed",
      source: "server-duress-shed",
      message: shedSummaryMessage(s),
      data: { ...s },
    });
  },
});

// Floor on the bell's re-alert window, and the reason a kind cannot opt out of
// re-alerting. A report IS a problem, and a problem that recurs after you
// dismissed it is news — so "never tell me again" is never the right answer,
// and there is deliberately no spelling for it. `meta.notifCooldownMs` is
// therefore only ever a RAISE above this floor (the engine takes the max),
// exactly the shape `meta.fanOutPerWindow` already has: a kind may ask for a
// LONGER quiet window, never for silence.
const RENOTIFY_FLOOR_MS = 10 * 60 * 1000;

// The kind of the fan-out rollup. Naming it here is the engine's one naming of
// a kind string, the precedent `duress-shed` above already sets: the engine
// files the accounting, and the kind that OWNS the payload schema, the
// fingerprint and the rendering lives in its own plugin
// (plugins/debug/plugins/report-storm), which declares itself fanOutExempt so
// the mechanism can never collapse its own accounting.
const STORM_KIND = "report-storm";

// The roster carries one message per collapsed fingerprint. A rollup names up
// to stormRosterMax of them, so the per-line clamp is far tighter than the
// row's MESSAGE_MAX — the roster is a "what was in the burst" index, not a
// second copy of every message.
const ROSTER_MESSAGE_MAX = 200;

function stormMessage(s: StormSummary): string {
  const seconds = Math.max(
    1,
    Math.round((s.windowEndedAt - s.windowStartedAt) / 1000),
  );
  const top = s.roster
    .slice(0, 3)
    .map((e) => `${e.message} ×${e.count}`)
    .join(", ");
  return (
    `${s.collapsedKind}: ${s.distinctFingerprints} fingerprints raised ` +
    `${s.occurrences} alerts in ${seconds}s past the ${s.budget}/window ceiling` +
    (top ? ` — top: ${top}` : "")
  );
}

// Cross-fingerprint fan-out ceiling (see fan-out.ts). The per-fingerprint
// velocity throttle below cannot see a burst that is spread ACROSS
// fingerprints — the 2026-09-02 incident, where 422 distinct slow-op
// fingerprints alerted in 24 s and every guard on the path keyed on the
// operation identity. Past the per-kind window budget, a NEWLY-alerting
// fingerprint folds into this kind's storm accumulator instead of minting a
// row; one rollup report per (kind, window) carries the accounting.
const fanOut = createFanOutGate({
  onStorm: (s) => {
    void recordReport({
      kind: STORM_KIND,
      source: "server-report-storm",
      message: stormMessage(s),
      data: { ...s },
    });
  },
});

// Single entry point used by the HTTP handler, the boot-time flush, and the
// process-level crash hooks. Every source collapses here so dedup lives in one
// place. The engine is fully generic: it looks up the matching ReportKindSpec
// and delegates schema validation, fingerprinting, and presentation to it. The
// only kind strings it names are the two accounting rollups it files itself
// (duress-shed, report-storm), each of which owns its schema and rendering in
// its own plugin. No report auto-creates a task — investigation tasks are
// filed on demand by investigateReport().
export async function recordReport(
  input: ReportInput,
): Promise<RecordReportResult> {
  const {
    kind,
    source,
    message: rawMessage,
    url,
    userAgent,
    clientId,
    buildId,
  } = input;

  // Stamp the true event instant BEFORE the shed gate below: a report buffered
  // during a duress episode must carry its time through the buffer so replay
  // writes the in-freeze instant, not the flush time. Replay re-passes the
  // same object, so the stamp survives the buffer and the ??= is a no-op on
  // the replay pass.
  input.occurredAt ??= Date.now();
  const occurredAt = new Date(input.occurredAt);

  const spec = ReportKind.getContributions().find((k) => k.kind === kind);
  if (!spec) {
    // Fail loudly: a report whose kind has no registered spec is a wiring bug,
    // not a runtime condition to paper over with a default.
    throw new Error(
      `recordReport: no ReportKind registered for kind "${kind}". ` +
        `Registered kinds: ${
          ReportKind.getContributions()
            .map((k) => k.kind)
            .join(", ") || "(none)"
        }`,
    );
  }

  // Validate the per-kind payload against the kind's schema. parse() throws on a
  // malformed payload — again, a wiring bug we want surfaced, not swallowed. We
  // store the wire-level `data` (already a Record) so the persisted jsonb keeps
  // the exact shape the kind validated.
  const data = input.data;
  const parsed = spec.schema.parse(data);
  // The RAW message, not the clamped one below: the clamp is a display bound,
  // and letting it move would make a report's identity depend on how long its
  // message happened to be.
  const fp = await spec.fingerprint(parsed, {
    message: rawMessage ?? "",
    source,
  });

  // Duress shed gate — after kind lookup + schema validation + fingerprinting
  // (the cascade key), before any durable work. A shed report skips the
  // velocity bump too: velocity suppresses bell churn on the durable path, and
  // a shed report never reaches the bell; the replayed call bumps it once when
  // the report actually lands. The null result mirrors the no-row path.
  if (!spec.duressExempt) {
    const admitted = reportShed.admit({ input, fingerprint: fp });
    if (!admitted.persist) return { outcome: "shed" };
  }

  const worktree = runtimeNamespace();
  const message = clamp(rawMessage ?? "", MESSAGE_MAX);

  // Fan-out gate — after the duress gate (a replayed storm is still a storm,
  // and the duress-shed summary accounts for the replay separately) and before
  // any durable work. A collapsed occurrence writes no row and no
  // notification; it also skips the velocity bump below, for the same reason a
  // shed report does — velocity suppresses bell churn on the durable path, and
  // this occurrence never reaches the bell.
  if (!spec.fanOutExempt) {
    const admission = fanOut.admit({
      kind,
      fingerprint: fp,
      message: clamp(message, ROSTER_MESSAGE_MAX),
      fanOutPerWindow: spec.meta.fanOutPerWindow,
    });
    if (!admission.alert)
      return { outcome: "collapsed", stormKind: STORM_KIND };
  }

  const limited = bumpWindowAndCheck(fp);
  // A report whose originating bundle's graph hash differs from the graph this
  // server is serving came from an outdated frontend tab — benign version-skew.
  // Both sides are the artifact's content identity, so a rebuild that composed
  // the same graph does not make every open tab's reports look stale.
  const serverGraph = getServerGraphHash();
  const staleOrigin =
    buildId != null && serverGraph != null && buildId !== serverGraph;
  const { errorType, stack } = noiseFieldsFrom(data);
  const noise = isNoiseReport({
    source,
    errorType,
    message: rawMessage ?? "",
    stack,
    staleOrigin,
  });

  const id = reportIdKind.mint();
  // Wrapped in runWithoutProfiling: the reports insert/upsert is itself a `db`
  // span that would otherwise re-feed the slow-op recorder, which then files a
  // report, which writes again — a self-amplifying loop. Suppressing here covers
  // every report kind (crash + slow-op). The ALS propagates through the awaited
  // query, so the connection-acquire and query spans are suppressed too.
  //
  // Wrapped OUTSIDE that in runInBackgroundLane: a report is filed from whatever
  // context tripped it, so under origin-based DB gating this write would inherit
  // a human's lane and queue against the connections reserved for the request it
  // is describing. During the 2026-07-09 incident report fingerprint counts ran
  // into the thousands. Declaring it background is the fix; suppression alone is
  // a different claim ("don't record"), not a lane. See
  // research/2026-07-09-global-interactive-lane-origin-based-db-gating.md.
  const [row] = await runInBackgroundLane(() =>
    runWithoutProfiling(async () => {
      // The await MUST run inside the suppression scope. A bare `() => db…`
      // returns the lazy query unexecuted, so its execution (and the acquire +
      // query spans) would run after the ALS scope exits — defeating suppression
      // and re-opening the self-feedback loop. Likewise it must stay inside the
      // enclosing lane scope, or its connection is taken un-declared.
      return await writeReport({
        id,
        kind,
        fingerprint: fp,
        worktree,
        source,
        message,
        url: url ?? null,
        userAgent: userAgent ?? null,
        data,
        limited,
        noise,
        clientId: clientId ?? null,
        buildId: buildId ?? null,
        occurredAt,
      });
    }),
  );

  // An upsert with ON CONFLICT DO UPDATE always returns exactly one row; a
  // missing one is an impossible state, and the result union has no honest arm
  // for it. Fail loudly rather than hand back a "recorded" with no id.
  if (!row) {
    throw new Error(
      `recordReport: upsert returned no row for fingerprint "${fp}" (kind "${kind}")`,
    );
  }

  if (row.taskId === null && !row.noise) {
    reportRecordedSignal.emit({ reportId: row.id });
  }

  // Gate on the per-call `limited`, NOT the persisted `row.rateLimited`. The
  // throttle is ephemeral by design (see velocity.ts) — it suppresses bell
  // churn only while a fingerprint is actively bursting. `row.rateLimited` is an
  // OR-accumulated display flag ("was ever rate-limited") that is never reset, so
  // gating on it would permanently mute any long-lived singleton fingerprint
  // (e.g. the slow-op rollup) after its first burst.
  if (limited) {
    // Keep the row's count accurate but don't churn the bell: no notification
    // while this fingerprint bursts. The write above still routed its id — an
    // open Reports pane's count keeps moving, at most once per the producer's
    // 2 s window — so during a burst the pane and the bell deliberately
    // disagree.
    return {
      outcome: "recorded",
      reportId: row.id,
      taskId: row.taskId,
      rateLimited: true,
    };
  }

  // Mirror a "[Stale tab]" marker into the bell so the notification itself reads
  // as benign version-skew at a glance.
  const stalePrefix = staleOrigin ? "[Stale tab] " : "";
  const desc = `${stalePrefix}${row.message}`;
  // The bell notification is always keyed by the stable report id — exactly one
  // row per fingerprint, which updates in place. That dedup key is what keeps
  // the bell at one row per distinct problem instead of one per
  // (report × time-bucket), which previously grew the undismissed set without
  // bound. See
  // research/perfs/archive/2026-06-29-notifications-unbounded-resource-root-cause.md.
  //
  // The re-arm policy is the re-surface WINDOW, a separate axis from that key:
  // once the row has been quiet for the window it comes back as a fresh unread
  // alert (read/dismissed cleared, floated to the top), while every occurrence
  // inside the window only bumps its count. The window is never zero and never
  // infinite — it is RENOTIFY_FLOOR_MS, which a kind may raise but not lower
  // and not remove. So a crash you dismissed rings again the next time it
  // fires at least 10 minutes later, and a slow op that keeps tripping rings
  // at most that often.
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
  void runInBackgroundLane(() =>
    runWithoutProfiling(() =>
      recordNotification({
        type: "report",
        title: staleOrigin ? `${spec.meta.notif} (stale tab)` : spec.meta.notif,
        description: desc.length > 140 ? `${desc.slice(0, 137)}...` : desc,
        variant: spec.meta.variant,
        muted: row.noise,
        dedupeKey: row.id,
        resurfaceAfterMs,
        // Deep-link to the report's detail sidepane in Debug → Reports, never a task.
        // Investigation tasks are filed on demand from that pane.
        linkTo: reportDetailRoute.link(debugApp, { reportId: row.id }),
        metadata: {
          reportId: row.id,
          source: row.source,
          fingerprint: fp,
          clientId: clientId ?? null,
          buildId: buildId ?? null,
        },
      }),
    ),
  );
  return {
    outcome: "recorded",
    reportId: row.id,
    taskId: row.taskId,
    rateLimited: false,
  };
}

// The validated, clamped, fingerprinted values recordReport computes before
// the durable write — everything the upsert needs and nothing it re-derives.
export interface ReportUpsertValues {
  id: ReportId;
  kind: string;
  fingerprint: string;
  worktree: string;
  source: string;
  message: string;
  url: string | null;
  userAgent: string | null;
  data: Record<string, unknown>;
  limited: boolean;
  noise: boolean;
  clientId: string | null;
  buildId: string | null;
  // The event's true instant — under duress-shed replay this is EARLIER than
  // now (the in-freeze trip time carried through the buffer).
  occurredAt: Date;
}

// The durable write of recordReport: one upsert through the reports producer,
// which routes the row's id to live readers (coalesced to one flush per 2 s —
// see ./producer). Executor-parametrized so the DB-backed suite can drive the
// SQL semantics (greatest/least timestamps, the newest-occurrence guards)
// against a throwaway Postgres — the session-chain `recordSessionId(…, conn)`
// precedent. Production callers go through recordReport, which owns
// validation, the shed gate, velocity, the lane + profiling-suppression scopes,
// and the bell notification.
export async function writeReport(
  v: ReportUpsertValues,
  executor: ProducerExecutor = db,
): Promise<(typeof _reports.$inferSelect)[]> {
  return await reportsProducer.mutate(
    executor,
    (q, t) => buildUpsert(q, t, v),
    { latency: "background", returning: getTableColumns(_reports) },
  );
}

// The upsert statement itself, built and not executed: the producer runs it
// (and appends the RETURNING its emit reads).
function buildUpsert(
  q: ProducerExecutor,
  t: typeof _reports,
  v: ReportUpsertValues,
): ProducerBuilder<typeof _reports> {
  const { occurredAt } = v;
  // Timestamps take greatest/least so an out-of-order replay can never move
  // last_seen_at backwards (or first_seen_at forwards); the last-writer-wins
  // attribution columns (message / data / noise / lastClientId / lastBuildId)
  // only apply when this occurrence is at least as new as the row's
  // last_seen_at, so a replayed older report never clobbers fresher
  // attribution. ON CONFLICT SET expressions all read the PRE-update row, so
  // every guard sees the same last_seen_at consistently. created_at is the
  // row-write time (when the DB learned of it); updated_at is derived by the
  // table's trigger (derived-updated-at) — it moves only when a counted column
  // (message, data, count, the flags, taskId) really changes, so it is never
  // written here.
  const isNewest = sql`${occurredAt} >= ${t.lastSeenAt}`;
  return q
    .insert(t)
    .values({
      id: v.id,
      kind: v.kind,
      fingerprint: v.fingerprint,
      worktree: v.worktree,
      source: v.source,
      message: v.message,
      url: v.url,
      userAgent: v.userAgent,
      data: v.data,
      rateLimited: v.limited,
      noise: v.noise,
      lastClientId: v.clientId,
      lastBuildId: v.buildId,
      firstSeenAt: occurredAt,
      lastSeenAt: occurredAt,
    })
    .onConflictDoUpdate({
      target: [t.fingerprint, t.worktree],
      // Repeats land on the same row (the fingerprint is stable per kind): bump
      // the count, refresh the latest message + payload + attribution.
      set: {
        message: sql`case when ${isNewest} then ${v.message} else ${t.message} end`,
        // Explicit ::jsonb cast: this rides a raw sql param (not the column's
        // drizzle mapper), so the driver must not guess the wire type.
        data: sql`case when ${isNewest} then ${JSON.stringify(v.data)}::jsonb else ${t.data} end`,
        count: sql`${t.count} + 1`,
        firstSeenAt: sql`least(${t.firstSeenAt}, ${occurredAt})`,
        lastSeenAt: sql`greatest(${t.lastSeenAt}, ${occurredAt})`,
        rateLimited: sql`${t.rateLimited} OR ${v.limited}`,
        noise: sql`case when ${isNewest} then ${v.noise} else ${t.noise} end`,
        lastClientId: sql`case when ${isNewest} then ${v.clientId} else ${t.lastClientId} end`,
        lastBuildId: sql`case when ${isNewest} then ${v.buildId} else ${t.lastBuildId} end`,
      },
    });
}
