import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { getTableColumns, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type {
  ProducerBuilder,
  ProducerExecutor,
} from "@plugins/network/plugins/live/plugins/change-feed/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  getServerGraphHash,
  serverPinCommit,
} from "@plugins/build/plugins/server-build-id/server";
import {
  createShedBuffer,
  type ShedSummary,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/shed/server";
import { reportsProducer } from "./producer";
import { reportOutboxSink } from "./outbox-sink";
import { bumpWindowAndCheck } from "./velocity";
import { isNoiseReport } from "./noise";
import { noiseInputOf } from "./noise-input";
import {
  _reports,
  createFanOutGate,
  ReportKind,
  reportRecordedSignal,
  type StormSummary,
} from "@plugins/reports/server";
import { pickIncidentBell } from "./incident";
import { ringBell, type Bell } from "./bell";
import { fixedReportOccurrenceSink } from "./occurrence-sink";
import {
  REPORT_HOURLY_MAX,
  REPORT_RECENT_MAX,
  reportHourOf,
  fromOutdatedBundle,
  versionSkewMayExplain,
  reportIdKind,
  type ReportId,
  type ReportInput,
  type ReportOccurrence,
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
  | { outcome: "collapsed"; stormKind: string }
  // Filed from a process that cannot write `reports` (an exec child — a
  // supervised job's body — or a CLI): handed to the report outbox, which
  // main's backend drains and records (`reports/outbox`).
  | { outcome: "outbox" };

// The generic one-line summary is unbounded (an aggregated error can be hundreds
// of KB). Clamp it at the ingestion boundary so nothing downstream — the row,
// the notification, the task title — can ever exceed this. Kind-specific payload
// (stack, etc.) is clamped by the kind's renderTask when it builds the task
// description, where the ballooning actually hurt (markdown render).
export const MESSAGE_MAX = 4_000;

// Truncate the middle, keeping head + tail. The closing context of an aggregated
// error matters as much as the opening, so we drop the redundant middle.
export function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const omitted = value.length - max;
  return `${value.slice(0, head)}\n… [truncated ${omitted} chars] …\n${value.slice(value.length - tail)}`;
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

// Cross-fingerprint fan-out ceiling (see reports/server's fan-out.ts). The per-fingerprint
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
  stampCommit(input);
  if (!reportsProducer.writesHere()) return toOutbox(input);
  const filed = await fileReport(input);
  if (filed.bell) ringBell(filed.bell, null);
  return filed.result;
}

/**
 * How an incident is filed. `alert: false` — a catch-up of occurrences
 * already past, which a puller learned about late (site-reports'
 * reconciliation after the computer was away): every row lands, counts and
 * stays in the worklist exactly as otherwise, but no bell rings — history,
 * not news. A per-incident choice of the filer; a kind still cannot opt out
 * of the bell.
 */
export interface IncidentOptions {
  alert?: boolean;
}

/**
 * The reports ONE cause produced at one instant, most significant first: each
 * lands on its OWN fingerprint — row, count, velocity, fan-out and shed exactly
 * as `recordReport` — but the bell rings ONCE for the incident, not once per
 * row (`pickIncidentBell`: the first never-seen report when there is one, so a
 * new problem always surfaces; else the lead). Identity stays per problem, so
 * unrelated incidents never share a row and a report that only ever co-occurs
 * still has its own; only the alert is collapsed.
 */
export async function recordReportIncident(
  inputs: readonly ReportInput[],
  opts: IncidentOptions = {},
): Promise<RecordReportResult[]> {
  for (const input of inputs) stampCommit(input);
  // Sequential: the order is the caller's significance order, and the fan-out
  // budget is spent in it.
  if (!reportsProducer.writesHere()) {
    const outboxed: RecordReportResult[] = [];
    for (const input of inputs) outboxed.push(toOutbox(input));
    return outboxed;
  }
  const filed: FiledReport[] = [];
  for (const input of inputs) filed.push(await fileReport(input));
  const ringing = filed.flatMap((f) => (f.bell ? [f.bell] : []));
  // A noise row's bell is muted; it leads only an incident of noise.
  const loud = ringing.filter((b) => !b.row.noise);
  const bells = loud.length > 0 ? loud : ringing;
  const pick = pickIncidentBell(
    bells.map((b) => ({ isNew: b.row.count === 1 })),
  );
  if (pick && opts.alert !== false) {
    // The rows the incident wrote — a shed or collapsed member has none yet.
    const reportIds = filed.flatMap((f) =>
      f.result.outcome === "recorded" ? [f.result.reportId] : [],
    );
    ringBell(bells[pick.index]!, {
      related: reportIds.length - 1,
      fresh: pick.fresh,
      reportIds,
    });
  }
  return filed.map((f) => f.result);
}

// The commit the reporting code ran, for an in-process report that does not
// name one: this process's own pin (null when it cannot say — a mixed boot).
// A report from elsewhere names its own (a tab's bundle commit, an outbox
// entry's writer, a crash-buffer line's writer — null included), so only
// `undefined` is filled; stamped before the outbox hand-off too, so an exec
// child's report carries ITS pin.
function stampCommit(input: ReportInput): void {
  if (input.commit === undefined) input.commit = serverPinCommit();
}

// Only a serving host writes `reports` (the producer's A13): anywhere else —
// an exec child, whose sink handlers attach in every boot mode, or a CLI — the
// report goes to the outbox (`./outbox-sink`), which main drains and records
// under the `cli` source. The one chokepoint, so no caller has to know which
// process it is in.
function toOutbox(input: ReportInput): RecordReportResult {
  reportOutboxSink.emit(input);
  return { outcome: "outbox" };
}

// One report through the row path: its result, and the bell it would ring
// (null when it rings none — shed, collapsed or rate-limited).
interface FiledReport {
  result: RecordReportResult;
  bell: Bell | null;
}

async function fileReport(input: ReportInput): Promise<FiledReport> {
  const {
    kind,
    source,
    message: rawMessage,
    url,
    userAgent,
    clientId,
    buildId,
    commit,
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
    if (!admitted.persist) return { result: { outcome: "shed" }, bell: null };
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
      return {
        result: { outcome: "collapsed", stormKind: STORM_KIND },
        bell: null,
      };
  }

  const limited = bumpWindowAndCheck(fp);
  // Whether this occurrence's bundle's graph hash differs from the graph this
  // server is serving — a FACT about the occurrence (reports/core's
  // fromOutdatedBundle). Both sides are the artifact's content identity, so a
  // rebuild that composed the same graph does not make every open tab look
  // outdated. What it explains is judged on the ROW (versionSkewMayExplain):
  // the row's fact is sticky — one occurrence from a tab on the served graph
  // clears it for good — so noise is judged both ways here and the upsert
  // takes the verdict for the fact it ends with.
  const staleOrigin = fromOutdatedBundle({
    buildId,
    serverGraph: await getServerGraphHash(),
  });
  const judge = (rowStale: boolean) =>
    isNoiseReport(
      noiseInputOf({
        source,
        versionSkew: versionSkewMayExplain({ source, staleOrigin: rowStale }),
      }),
    );
  const noise: NoiseVerdicts = {
    ifStale: judge(true),
    ifCurrent: judge(false),
  };

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
        staleOrigin,
        clientId: clientId ?? null,
        buildId: buildId ?? null,
        commit: commit ?? null,
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
  // A report with a live or pending fix: does this occurrence's code contain
  // it? Judged off the recording path (a git read), and only for these rows.
  if (
    (row.fixState === "pending" || row.fixState === "fixed") &&
    row.fixCommit !== null
  ) {
    fixedReportOccurrenceSink.emit({
      reportId: row.id,
      fixCommit: row.fixCommit,
      deployed: row.fixState === "fixed",
      commit: commit ?? null,
      at: occurredAt,
    });
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
      result: {
        outcome: "recorded",
        reportId: row.id,
        taskId: row.taskId,
        rateLimited: true,
      },
      bell: null,
    };
  }

  return {
    result: {
      outcome: "recorded",
      reportId: row.id,
      taskId: row.taskId,
      rateLimited: false,
    },
    bell: {
      spec,
      row,
      fingerprint: fp,
      clientId: clientId ?? null,
      url: url ?? null,
      buildId: buildId ?? null,
    },
  };
}

/**
 * An occurrence's noise, judged against each value of the row's `staleOrigin`
 * after this write: `ifStale` when every occurrence so far (this one included)
 * came from an outdated tab, `ifCurrent` otherwise. They differ only for a
 * report version skew may explain (the stale-frontend rule).
 */
export interface NoiseVerdicts {
  ifStale: boolean;
  ifCurrent: boolean;
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
  /** This occurrence's noise verdict, for each fact the row may end with. */
  noise: NoiseVerdicts;
  /**
   * This occurrence came from an outdated bundle (`fromOutdatedBundle`, judged
   * now — never re-derived). The row keeps it only while EVERY occurrence did.
   */
  staleOrigin: boolean;
  clientId: string | null;
  buildId: string | null;
  /** The commit the reporting code ran; null when it could not name one. */
  commit: string | null;
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
  // This occurrence as `recent` keeps it. On a repeat it joins the kept ones,
  // ordered by the occurrence's own instant (so an out-of-order replay lands
  // where it happened) and cut to the newest REPORT_RECENT_MAX.
  const occurrence: ReportOccurrence = {
    at: occurredAt.getTime(),
    message: v.message,
    clientId: v.clientId,
    url: v.url,
    buildId: v.buildId,
    commit: v.commit,
  };
  const recent = sql`(
    select coalesce(jsonb_agg(o order by (o->>'at')::bigint desc), '[]'::jsonb)
    from (
      select o from jsonb_array_elements(
        jsonb_build_array(${JSON.stringify(occurrence)}::jsonb) || ${t.recent}
      ) o
      order by (o->>'at')::bigint desc
      limit ${REPORT_RECENT_MAX}
    ) kept
  )`;
  // This occurrence's hour joins `hourly`: summed into its bucket, cut to the
  // newest REPORT_HOURLY_MAX hours. A row with no `hourly` yet (first seen
  // before it existed) starts counting here and says so (`untrackedBefore`):
  // the write time, not the occurrence's — a replayed older occurrence must
  // not claim the untracked ones between it and now were counted.
  const hour = reportHourOf(occurredAt.getTime());
  const countingFrom = Math.max(occurredAt.getTime(), Date.now());
  const hourly = sql`jsonb_build_object(
    'untrackedBefore',
    case when ${t.hourly} is null
      then to_jsonb(${countingFrom}::bigint)
      else ${t.hourly}->'untrackedBefore' end,
    'hours',
    (
      select coalesce(jsonb_agg(jsonb_build_object('h', h, 'n', n) order by h desc), '[]'::jsonb)
      from (
        select (b->>'h')::bigint h, sum((b->>'n')::int)::int n
        from jsonb_array_elements(
          coalesce(${t.hourly}->'hours', '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object('h', ${hour}::bigint, 'n', 1))
        ) b
        group by 1
        order by 1 desc
        limit ${REPORT_HOURLY_MAX}
      ) kept
    )
  )`;
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
      recent: [occurrence],
      hourly: { hours: [{ h: hour, n: 1 }], untrackedBefore: null },
      rateLimited: v.limited,
      noise: v.staleOrigin ? v.noise.ifStale : v.noise.ifCurrent,
      staleOrigin: v.staleOrigin,
      lastClientId: v.clientId,
      lastBuildId: v.buildId,
      lastCommit: v.commit,
      firstSeenAt: occurredAt,
      lastSeenAt: occurredAt,
    })
    .onConflictDoUpdate({
      target: [t.fingerprint, t.worktree],
      // Repeats land on the same row (the fingerprint is stable per kind): bump
      // the count, refresh the latest message + payload + attribution.
      set: {
        message: sql`case when ${isNewest} then ${v.message} else ${t.message} end`,
        url: sql`case when ${isNewest} then ${v.url} else ${t.url} end`,
        recent,
        hourly,
        // Explicit ::jsonb cast: this rides a raw sql param (not the column's
        // drizzle mapper), so the driver must not guess the wire type.
        data: sql`case when ${isNewest} then ${JSON.stringify(v.data)}::jsonb else ${t.data} end`,
        count: sql`${t.count} + 1`,
        firstSeenAt: sql`least(${t.firstSeenAt}, ${occurredAt})`,
        lastSeenAt: sql`greatest(${t.lastSeenAt}, ${occurredAt})`,
        rateLimited: sql`${t.rateLimited} OR ${v.limited}`,
        // Sticky: the row stays "only ever seen from outdated tabs" while every
        // occurrence was — whatever their order — and one occurrence from a tab
        // on the served graph clears it for good (that code path is live in
        // the current build, so no reload explains it). The noise follows the
        // fact the row ends with: the newest occurrence's verdict for it, or —
        // for an older replay — the row's own, re-judged on this occurrence
        // when the replay is what clears the fact.
        noise: v.staleOrigin
          ? sql`case when ${isNewest} then (case when ${t.staleOrigin} then ${v.noise.ifStale}::boolean else ${v.noise.ifCurrent}::boolean end) else ${t.noise} end`
          : sql`case when ${isNewest} or ${t.staleOrigin} then ${v.noise.ifCurrent}::boolean else ${t.noise} end`,
        staleOrigin: sql`${t.staleOrigin} and ${v.staleOrigin}::boolean`,
        lastClientId: sql`case when ${isNewest} then ${v.clientId} else ${t.lastClientId} end`,
        lastBuildId: sql`case when ${isNewest} then ${v.buildId} else ${t.lastBuildId} end`,
        lastCommit: sql`case when ${isNewest} then ${v.commit} else ${t.lastCommit} end`,
      },
    });
}
