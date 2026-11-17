import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  isSuspendSignal,
  NonRetryableError,
  type JobCtx,
} from "@plugins/infra/plugins/jobs/server";
import type { EventSource } from "@plugins/apps/plugins/events/plugins/events-core/core";
import {
  _eventSources,
  getEventSourceType,
  markEventsDisappeared,
  upsertEvents,
  type EventSourceType,
  type ProbeContext,
} from "@plugins/apps/plugins/events/plugins/events-core/server";
import { extractionCacheKey } from "./cache-key";
import { classifyRefreshError, isNonRetryable } from "./classify-error";
import { planEventWrites } from "./plan-writes";
import {
  finishExtracted,
  finishFailed,
  finishUnchanged,
  markSourceRunning,
  releaseSuspendedSource,
} from "./run-ledger";
import { refreshLog } from "./sink";
import {
  eventRunIdKind,
  eventSourceIdKind,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

// THE engine. The only place that knows the phase order, and deliberately the
// only thing in this file: every line below is one high-level action, with the
// HTTP / LLM / SQL detail behind the source type, the repo funnel, and the
// ledger.

/**
 * The source names a type this composition does not install. Deterministic — no
 * retry installs a plugin — so `classifyRefreshError` reads this name and makes
 * it terminal, parking the source with a message the user can act on.
 */
class UnknownSourceTypeError extends Error {
  constructor(source: EventSource) {
    super(
      `No event source type "${source.type}" is installed in this composition.`,
    );
    this.name = "UnknownSourceTypeError";
  }
}

type SourceLookup = { kind: "found"; source: EventSource } | { kind: "gone" };

/**
 * Read the source a queued job names. "Gone" is a legitimate outcome, not a
 * failure — a user may delete a source between the tick's enqueue and its
 * dispatch — so it is a variant of the result rather than a throw or a `null`
 * a caller could mistake for a row.
 */
async function loadSource(sourceId: string): Promise<SourceLookup> {
  const [source] = await db
    .select()
    .from(_eventSources)
    .where(eq(_eventSources.id, eventSourceIdKind.key(sourceId)))
    .limit(1);
  return source ? { kind: "found", source } : { kind: "gone" };
}

function requireSourceType(source: EventSource): EventSourceType {
  const sourceType = getEventSourceType(source.type);
  if (!sourceType) throw new UnknownSourceTypeError(source);
  return sourceType;
}

function probeContext(
  source: EventSource,
  runId: string,
  job: Pick<JobCtx, "sleep">,
): ProbeContext<unknown> {
  return { sourceId: source.id, config: source.config, runId, job };
}

/**
 * Refresh one source, end to end.
 *
 *     mark running → probe → (config, fingerprint) matched ?
 *        yes → record run{unchanged}, bump the watermark, DONE (no extraction)
 *        no  → extract → derive identities → upsert → stamp disappearances
 *            → record run{extracted}, store the fingerprint, bump the watermark
 *
 * Two invariants the shape enforces rather than documents:
 *
 * - `extract` is unreachable on a cache hit. The engine — not the source type —
 *   holds `lastFingerprint`, so "don't pay for the model when nothing changed"
 *   cannot be forgotten by a future source type.
 * - Disappearance is stamped ONLY after a successful full extraction. It sits
 *   inside the `try` after `extract`, so a failure exits before it and a flaky
 *   scrape can never mark the user's whole list gone.
 */
export async function runSource(
  sourceId: string,
  job: Pick<JobCtx, "sleep">,
): Promise<void> {
  const lookup = await loadSource(sourceId);
  if (lookup.kind === "gone") {
    refreshLog.publish(`source ${sourceId} was deleted before its run started`);
    return;
  }
  const source = lookup.source;
  if (!source.enabled) {
    refreshLog.publish(`source ${source.id} is disabled — skipping run`);
    return;
  }

  // The run's identity, minted BEFORE the first phase even though its ledger row
  // is written at the end. Work in flight (a model call, a fetched artifact) can
  // then stamp itself with the run it belongs to, which is the only way that
  // artifact is reachable from the outcome that explains it. The ledger's
  // invariant is untouched: the row still appears exactly once, complete.
  const runId = eventRunIdKind.mint();
  const startedAt = new Date();
  await markSourceRunning(source.id);

  try {
    // Inside the `try` on purpose: an uninstalled source type is a real,
    // user-visible misconfiguration, so it must reach the ledger and the source
    // row's classified error like any other terminal failure — not vanish as a
    // bare throw with nothing on screen to explain it.
    const sourceType = requireSourceType(source);
    const probed = await sourceType.probe(probeContext(source, runId, job));
    // Keyed on the config too: `extract` may apply it (filters), so an edited
    // config must re-extract even when the material did not move.
    const fingerprint = extractionCacheKey(source.config, probed.fingerprint);
    // The cache hit — the ONLY path that skips extraction. A `null` fingerprint
    // is never a hit however often it repeats: the source type is declaring it
    // cannot fingerprint cheaply, so it must always extract. Do not "simplify"
    // this to a bare `===`, which would turn that declaration into a permanent
    // skip the moment two consecutive probes both report `null`.
    if (fingerprint !== null && fingerprint === source.lastFingerprint) {
      await finishUnchanged(source, { runId, startedAt, fingerprint });
      return;
    }

    const { events, flags } = await sourceType.extract(
      probed.payload,
      probeContext(source, runId, job),
    );
    // The clock the plan is normalized against, read ONCE and passed in: the
    // anchor of every event in this run is then resolved against the same
    // instant, so two events of one page can never straddle a midnight.
    const plan = planEventWrites(source.id, events, { now: new Date() });
    const { created, updated, touched } = await upsertEvents(plan.inputs);
    const disappeared = await markEventsDisappeared(
      source.id,
      plan.seenExternalIds,
    );

    await finishExtracted(source, {
      runId,
      startedAt,
      fingerprint,
      flags,
      counts: {
        found: plan.inputs.length,
        created,
        updated,
        disappeared: disappeared.length,
      },
      // The same two writes above, stated per event: the ledger records WHICH
      // events this run touched, not only how many. The counts below are derived
      // from the identical values, so the summary and the list cannot disagree.
      touched: [...touched, ...disappeared],
    });
  } catch (err) {
    // A phase slept the run (a model call waiting out the Claude account's
    // usage limit): nothing failed. The run ends with no ledger row — it never
    // completed — and the source drops its `running` flag until the run
    // resumes, from the top, at the wake-up.
    if (isSuspendSignal(err)) {
      await releaseSuspendedSource(source);
      throw err;
    }
    const failure = classifyRefreshError(err);
    await finishFailed(source, { runId, startedAt, failure });
    // Record first, then rethrow: the job must still FAIL (loudly, into the
    // queue's dead-letter accounting) — recording it on the row is reporting,
    // not handling. A terminal failure is rethrown as `NonRetryableError` so
    // graphile dead-letters after this single attempt rather than re-running an
    // extraction that will fail identically.
    if (!failure.terminal || isNonRetryable(err)) throw err;
    throw new NonRetryableError(failure.message, { cause: err });
  }
}
