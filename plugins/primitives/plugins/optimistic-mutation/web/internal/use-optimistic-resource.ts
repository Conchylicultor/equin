import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useResource,
  useResourceAcks,
  queryKeyFor,
  useLiveRegistries,
  useLiveSocketKindOf,
} from "@plugins/primitives/plugins/live-state/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import type {
  ResourceDescriptor,
  ResourceError,
} from "@plugins/primitives/plugins/live-state/core";
import type {
  LiveRowsCollection,
  LiveValue,
} from "@plugins/network/plugins/live/core";
import { subscribeWsStatus } from "@plugins/primitives/plugins/networking/web";
import {
  EndpointError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import {
  clientLatencySink,
  splitPhases,
  type ClientLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import {
  optimisticDivergenceReportSink,
  optimisticRejectionSink,
  REJECTION_MESSAGE_MAX,
} from "../reporter";
import { enqueueResourceSend, sendLaneKey } from "./send-lane";
import {
  ackPass,
  classifyRejection,
  clearFailure,
  confirmPass,
  markFailed,
  markSent,
  rejectOp,
  replay,
  resolvePass,
  type ConfirmedOp,
  type OpFailure,
  type PendingOp,
  type ReconcileResult,
} from "./overlay";
import { hiddenSince } from "./tab-hidden";

// Canonical params serialization for the ack-edge tuple match — byte-identical
// to the registries' `paramsKey` (sorted-key JSON), so the subscription fires
// ackPass only for exactly this hook's (key, params) tuple.
function ackParamsKey(params: Record<string, string> | undefined): string {
  if (!params) return "{}";
  const keys = Object.keys(params).sort();
  const obj: Record<string, string> = {};
  for (const k of keys) obj[k] = params[k]!;
  return JSON.stringify(obj);
}

/**
 * The lifecycle edge an op confirmed on — the second half of a confirm
 * sample's variant (`<mode>/<edge>`): `push` (a snapshot landed after the
 * response), `resolve` (the confirming frame beat the response, so
 * `confirm-frame` is 0), `ack` (a standalone ack frame).
 */
type ConfirmEdge = "push" | "resolve" | "ack";

/**
 * Times one confirmed op as a `confirm` latency sample. Every phase is on the
 * client's monotonic clock (`performance.now()`), so none carries skew. A
 * confirmed op was resolved, and a resolved op was sent — a missing stamp is a
 * lifecycle bug, so it throws rather than emitting a made-up phase.
 */
function confirmSample<Vars>(
  { op, mode }: ConfirmedOp<Vars>,
  edge: ConfirmEdge,
  key: string,
  params: Readonly<Record<string, string>>,
  confirmedAt: number,
): Extract<ClientLatencySample, { signal: "confirm" }> {
  const { dispatchedAt, firstSentAt, lastSentAt, ackedAt } = op;
  if (
    firstSentAt === undefined ||
    lastSentAt === undefined ||
    ackedAt === undefined
  )
    throw new Error(
      `optimistic-mutation: confirmed op ${op.opId} on ${key} is missing a send/ack stamp`,
    );
  return {
    signal: "confirm",
    key,
    params,
    variant: `${mode}/${edge}`,
    phases: splitPhases("confirm", {
      "send-lane": firstSentAt - dispatchedAt,
      retry: lastSentAt - firstSentAt,
      "server-ack": ackedAt - lastSentAt,
      "confirm-frame": confirmedAt - ackedAt,
    }),
    totalMs: confirmedAt - dispatchedAt,
    hidden: hiddenSince(dispatchedAt),
  };
}

/**
 * How one `mutate` attempt ended: accepted, failed in place (an `OpFailure`
 * kind — the op stays rendered), or permanently rejected (the op is gone).
 */
type MutateOutcome = "resolved" | OpFailure["kind"] | "rejected";

/**
 * What an optimistic read does with its ops — everything but the read itself,
 * which is positional (`useOptimisticResource(value, params?, options)` /
 * `(collection, { ids }, options)`).
 */
interface OptimisticOpArgs<Data, Vars> {
  /** Pure predicted next state. Must not mutate `current`. */
  apply: (current: Data, vars: Vars) => Data;
  /**
   * Network thunk; resolves on server 2xx (the op was accepted). Return
   * `{ watermark }` — the commit's `pg_current_xact_id()::text` read inside the
   * write transaction (Rule A) — to upgrade this op to exact causal
   * confirmation/denial; a plain `Promise<void>` stays tokenless (legacy
   * coarse / content-only confirmation, no denial).
   */
  mutate: (vars: Vars) => Promise<void | { watermark?: string }>;
  /**
   * Fires on every `mutate` rejection. `outcome.rejected` is true when the
   * server PERMANENTLY rejected the op (`classifyRejection`) and it has already
   * left the overlay — the consumer's cue to unwind any side state it keyed on
   * the op (an undo entry). Otherwise the op is still rendered, awaiting retry.
   */
  onError?: (
    err: unknown,
    vars: Vars,
    outcome: { opId: string; rejected: boolean },
  ) => void;
  /**
   * Names the thing being saved; surfaced in the sync-status error state and
   * the rejection toast.
   */
  label?: string;
  /**
   * Short, bounded description of an op, used ONLY in the divergence and
   * rejection reports
   * (`vars` itself is unbounded and possibly unserializable, so it is never
   * shipped). Must be pure and total — it runs on the reconcile path, and a
   * throw propagates loudly rather than being swallowed.
   */
  describeOp?: (vars: Vars) => string;
}

/**
 * Confirmation mode. Coarse (neither field) clears a resolved op once a
 * snapshot causally past its ack token has landed (or, tokenless, once an
 * authoritative push has landed since it was dispatched). Content-based
 * REQUIRES both fields together: `isConfirmedBy(serverData, vars)` asks "has
 * this server snapshot already reflected `vars`?" (precise content check, e.g.
 * "row id X present"), and `sameTarget(a, b)` declares op identity ("do `a` and
 * `b` write the SAME entity/key?").
 *
 * Precise per-op matching implies concurrent per-entity ops in flight — i.e. a
 * structurally multi-target consumer — where the overlay's being an ORDERED
 * FOLD starts to bite: an op's rendered effect is defined relative to the ops
 * before it, so letting one leave while an older op it was folded on top of is
 * still replaying renders a state the user never created. `sameTarget` is what
 * the ordering rule reads to prevent that (`overlay.ts` — an op may not leave
 * while an older, still-surviving, same-target op remains). It only ever makes
 * an op WAIT, so over-approximating is safe and under-approximating merely
 * narrows the protection.
 *
 * `isConfirmedBy` without `sameTarget` (or vice versa) is therefore
 * unrepresentable.
 */
type ConfirmationArgs<Data, Vars> =
  | { isConfirmedBy?: undefined; sameTarget?: undefined }
  | {
      isConfirmedBy: (serverData: Data, vars: Vars) => boolean;
      sameTarget: (a: Vars, b: Vars) => boolean;
    };

/** An optimistic read's options: the ops half, with the confirmation pair. */
export type OptimisticOptions<Data, Vars> = OptimisticOpArgs<Data, Vars> &
  ConfirmationArgs<Data, Vars>;

/**
 * An optimistic read's result, named by `status` like every live read:
 * `loading` / `error` until a base exists, then `ready` — the only arm that can
 * `dispatch`: an op can never be made against a base nobody has seen. There is
 * no placeholder base.
 *
 * The one difference from a `ResourceResult` (live-state's named exemption):
 * a base is the first authoritative value OR the last one under a transient
 * error, so once a value has landed a failing read stays `ready` — an editor
 * keeps painting instead of blanking — and carries the failure as the ready
 * arm's `error` (sync-status reports it with a Retry). `error` is the arm only
 * for a read that failed before any value landed.
 */
export type OptimisticResult<Data, Vars> =
  | {
      status: "loading";
      /** Re-fetch the resource. */
      refetch: () => Promise<void>;
    }
  | {
      status: "error";
      /** The first-load failure — no base has ever landed. */
      error: ResourceError;
      /** Re-fetch the resource — the Retry for a failed load. */
      refetch: () => Promise<void>;
    }
  | ({ status: "ready" } & OptimisticSettled<Data, Vars>);

/** The settled arm of {@link OptimisticResult}. */
export interface OptimisticSettled<Data, Vars> {
  /** Server truth with all pending ops replayed. */
  data: Data;
  /**
   * Raw authoritative server truth — the overlay base, with NO pending ops
   * applied. For consumers that must tell "the server has really absorbed
   * this" from the prediction (e.g. gating a dependent write on a row's real,
   * FK-satisfying existence).
   */
  serverData: Data;
  /**
   * A transient load error the surface keeps painting through (the base is the
   * last authoritative value — the sanctioned exemption to live-state's I1), or
   * null. Sync-status already reports it with a Retry. Null once a fresh
   * authoritative value lands.
   */
  error: ResourceError | null;
  /** Re-fetch the resource — the Retry for {@link error} (not for failed ops: see `retry`). */
  refetch: () => Promise<void>;
  /** Enqueue an overlay op + fire `mutate`; returns the minted opId. */
  dispatch: (vars: Vars) => string;
  /**
   * Every op still in the overlay — including ones the server has already
   * ACKED but whose confirming push hasn't been matched yet, and ones whose
   * `mutate` rejected (a failed edit keeps rendering — never-revert). This is
   * the replay set, NOT the "is anything unsaved" signal: read `saving` for that.
   */
  pendingOps: ReadonlyArray<{ opId: string; vars: Vars }>;
  /** True while at least one op's `mutate` has not come back yet. */
  saving: boolean;
  /**
   * Ops whose `mutate` the server failed with a TRANSIENT HTTP status
   * (`EndpointError`, see `classifyRejection`). They are still rendered (still
   * in `pendingOps`) but need an explicit `retry` to converge. A PERMANENTLY
   * rejected op is never here — it has already left the overlay and been
   * reported. Network-level failures (fetch rejected —
   * offline, restarting server) are deliberately NOT here: nothing is known to
   * be wrong with those ops, so they stay `syncing` and auto-retry on the next
   * reconnect edge.
   */
  failed: ReadonlyArray<{ opId: string; vars: Vars }>;
  /**
   * Re-fire a failed op's `mutate` IN PLACE: same opId, same overlay position —
   * the rendered prediction never moves or flickers.
   */
  retry: (opId: string) => void;
}

/** The `{ ids }` read of a collection — its `:rows` point sibling. */
interface OptimisticIdsQuery {
  ids: readonly string[];
}

/**
 * Optimistic read of a declared `liveValue` (param-less): `loading` (or
 * `error`), then the `ready` arm with `data` / `serverData` / `dispatch`.
 *
 * ```ts
 * const picks = useOptimisticResource(prototypePicks, { name }, { apply, mutate });
 * if (picks.status === "loading") return <Loading />;
 * if (picks.status === "error") return <ResourceErrorInline error={picks.error} refetch={picks.refetch} />;
 * picks.dispatch(change);               // only on the settled arm
 * ```
 */
export function useOptimisticResource<Data, Vars>(
  value: LiveValue<Data, Record<string, never>>,
  options: OptimisticOptions<NoInfer<Data>, Vars>,
): OptimisticResult<Data, Vars>;
/** Optimistic read of a parameterized `liveValue` at `params`. */
export function useOptimisticResource<
  Data,
  Vars,
  P extends Record<string, string>,
>(
  value: LiveValue<Data, P>,
  params: P,
  options: OptimisticOptions<NoInfer<Data>, Vars>,
): OptimisticResult<Data, Vars>;
/**
 * Optimistic read of an explicit id set of a `liveCollection` (its `:rows`
 * point sibling — the same read as `useLive(c, { ids })`). Rows are unordered.
 * Any collection has the sibling — a window, `all` or lookup-only one — so any
 * collection takes it, exactly as `useLive(c, { ids })` does.
 */
export function useOptimisticResource<Row, Vars>(
  collection: LiveRowsCollection<Row>,
  query: OptimisticIdsQuery,
  options: OptimisticOptions<Row[], Vars>,
): OptimisticResult<Row[], Vars>;
export function useOptimisticResource<Data, Vars>(
  source: object,
  second?: object,
  third?: OptimisticOptions<Data, Vars>,
): OptimisticResult<Data, Vars> {
  // The form is fixed for a call site (a declaration is a module-level const
  // and the argument count never changes), and it is resolved here with no
  // hooks, so every form runs the same ONE core hook.
  const form = resolveForm<Data, Vars>(source, second, third);
  return useOptimisticCore<Data, Vars>(
    form.resource,
    form.params,
    form.options,
  );
}

interface ResolvedForm<Data, Vars> {
  resource: ResourceDescriptor<Data, Record<string, string>>;
  params: Record<string, string> | undefined;
  options: OptimisticOptions<Data, Vars>;
}

function resolveForm<Data, Vars>(
  source: object,
  second: object | undefined,
  third: OptimisticOptions<Data, Vars> | undefined,
): ResolvedForm<Data, Vars> {
  if ("live" in source) {
    return {
      resource: source as unknown as ResourceDescriptor<
        Data,
        Record<string, string>
      >,
      params:
        third === undefined ? undefined : (second as Record<string, string>),
      options: (third ?? second) as OptimisticOptions<Data, Vars>,
    };
  }
  // A collection's `{ ids }` read: the `:rows` point sibling at the canonical
  // encoding of the id set.
  const rows = (source as LiveRowsCollection<unknown>).rows;
  return {
    resource: rows as unknown as ResourceDescriptor<
      Data,
      Record<string, string>
    >,
    params: rows.point.encode((second as OptimisticIdsQuery).ids),
    options: third as OptimisticOptions<Data, Vars>,
  };
}

// A params object with a stable identity per canonical content, so the
// query-key memo and the effects keyed on it do not churn when a caller (or
// the ids codec) builds an equal object each render.
function useStableParams(
  params: Record<string, string> | undefined,
  optional: readonly string[] | undefined,
): Record<string, string> | undefined {
  // Canonical (`canonicalParams`), so every key this hook derives from the
  // params — its QueryCache subscription, send lane, tx-ack and watermark
  // lookups — names the tuple `useResource` subscribes, however an absent
  // optional param is spelled.
  const json =
    params === undefined
      ? null
      : JSON.stringify(canonicalParams(params, optional));
  return useMemo(
    () =>
      json === null ? undefined : (JSON.parse(json) as Record<string, string>),
    [json],
  );
}

function useOptimisticCore<Data, Vars>(
  resource: ResourceDescriptor<Data, Record<string, string>>,
  rawParams: Record<string, string> | undefined,
  options: OptimisticOptions<Data, Vars>,
): OptimisticResult<Data, Vars> {
  const params = useStableParams(rawParams, resource.optionalParams);
  const { apply, mutate, onError, label, describeOp } = options;
  // Narrow on the object (not a destructure) so TS keeps the union correlation:
  // when `options.isConfirmedBy` is truthy, `options` is the paired arm and
  // `options.sameTarget` is known-defined.
  const confirmation = options.isConfirmedBy
    ? { isConfirmedBy: options.isConfirmedBy, sameTarget: options.sameTarget }
    : undefined;
  const queryClient = useQueryClient();
  // The enclosing pipeline's causal-floor registries and socket identities —
  // the page's own, or a scoped transport's (live-state `NotificationsProvider`).
  const { watermarks, txAcks } = useLiveRegistries();
  const socketKindOf = useLiveSocketKindOf();
  const result = useResource(resource, params);
  // Every optimistic reader asks for standalone ack frames on its tuple: a
  // write that changes nothing this tuple can see (a net-zero diff, a row
  // outside the id set) is then still confirmed exactly, instead of hanging
  // until an unrelated frame. Asked by the reader, so it cannot be forgotten
  // and a tuple nobody writes optimistically pays nothing.
  useResourceAcks(resource, params);
  // Optimistic surfaces are the sanctioned, LOUD exemption to live-state's
  // "an error is not ready": they are editors, so under a transient error they
  // deliberately KEEP PAINTING last-known-good rather than blanking —
  // `sync-status` (wired below via useReportSync) owns their error affordance.
  // So the overlay base falls back to `result.stale` (the last authoritative
  // value) — and no further: there is no placeholder base, so no base means
  // loading (or, after a failure, error). Once a value has landed, an error
  // keeps the `ready` arm (painting last-known-good) and rides on its `error`.
  let base: Data | undefined;
  // The read's failure (if any), surfaced so editor surfaces can report it
  // (they keep painting `base`).
  let resultError: ResourceError | null;
  switch (result.status) {
    case "ready":
      base = result.data;
      resultError = null;
      break;
    case "error":
      base = result.stale;
      resultError = result.error;
      break;
    case "loading":
      base = undefined;
      resultError = null;
      break;
  }

  const [pending, setPending] = useState<ReadonlyArray<PendingOp<Vars>>>([]);
  // Explicit "everything this hook dispatched has been acked" timestamp,
  // reported to sync-status. Stamped inside the resolve handler, never inferred
  // from a derived boolean (a transient boolean can be coalesced away within one
  // React render — the exact hazard sync-status/CLAUDE.md documents).
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Commit mirror of `pending`. Every lifecycle edge (dispatch / resolve /
  // reject / retry / push) fires from an event or promise callback, decides the
  // next overlay against this ref, and writes both. A functional `setPending`
  // updater cannot be used: the pure machine returns `{ pending, dropped,
  // stalled }`, and extracting the report lists from inside an updater would
  // make the updater effectful (React may invoke it twice). Sequential edges
  // within one tick chain correctly because the ref is written synchronously.
  const pendingRef = useRef<ReadonlyArray<PendingOp<Vars>>>([]);
  const commitPending = useCallback((next: ReadonlyArray<PendingOp<Vars>>) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  // Latest-value refs so the QueryCache subscription effect can stay mounted for
  // the resource's lifetime without re-subscribing on every render.
  const applyRef = useLatestRef(apply);
  const confirmationRef = useLatestRef(confirmation);
  const describeOpRef = useLatestRef(describeOp);
  const labelRef = useLatestRef(label);
  const paramsRef = useLatestRef(params);
  const mutateRef = useLatestRef(mutate);
  const onErrorRef = useLatestRef(onError);

  const queryKey = useMemo(
    () => queryKeyFor(resource.key, params),
    [resource.key, params],
  );
  const queryKeyRef = useLatestRef(queryKey);
  const targetKey = useMemo(() => JSON.stringify(queryKey), [queryKey]);
  // This tuple's send lane (module-level, shared with every other mount on the
  // same `(key, params)`). Read off a latest-ref at call time so dispatch/retry/
  // drain keep stable identities while still enqueuing onto the LIVE tuple's
  // lane — ops never outlive their tuple, so a params re-baseline swaps lanes
  // with it.
  const laneKey = useMemo(
    () => sendLaneKey(resource.key, params),
    [resource.key, params],
  );
  const laneKeyRef = useLatestRef(laneKey);

  // The server-acked ops and the server's snapshots durably disagree — either
  // provably superseded (dropped, healthy) or stalled past the miss threshold
  // (kept, one-shot investigation signal). Not a spinner state (the writes DID
  // succeed) — a loud, deduped report, via the sanctioned sink inversion
  // (`error-boundary` → `reports.crash` is the precedent), because the
  // primitive must not import `reports`. `emit` never throws.
  const reportDivergence = useCallback(
    (kind: "superseded" | "stalled", ops: ReadonlyArray<PendingOp<Vars>>) => {
      const describe = describeOpRef.current;
      optimisticDivergenceReportSink.emit({
        kind,
        resourceKey: resource.key,
        params: paramsRef.current ?? null,
        label: labelRef.current ?? null,
        misses: Math.max(...ops.map((op) => op.misses)),
        opSummaries: describe ? ops.map((op) => describe(op.vars)) : [],
      });
    },
    // The latest-ref handles are stable; only the resource key participates.
    [resource.key],
  );
  // Every edge's outcomes: the divergence reports, and one `confirm` latency
  // sample per confirmed op (skipped wholesale when nobody listens).
  const reportOutcomes = useCallback(
    (next: ReconcileResult<Vars>, edge: ConfirmEdge) => {
      if (next.dropped.length > 0) reportDivergence("superseded", next.dropped);
      if (next.stalled.length > 0) reportDivergence("stalled", next.stalled);
      if (next.confirmed.length > 0 && clientLatencySink.hasSubscribers()) {
        const confirmedAt = performance.now();
        const params = paramsRef.current ?? {};
        for (const confirmed of next.confirmed)
          clientLatencySink.emit(
            confirmSample(confirmed, edge, resource.key, params, confirmedAt),
          );
      }
    },
    // The latest-ref handles are stable; only these participate.
    [reportDivergence, resource.key],
  );

  // Exact-ack membership probe against the pipeline's tx-ack registry,
  // namespaced to THIS hook's live tuple (`paramsRef.current`, so a params
  // re-baseline swaps the namespace with it — a wrong-tuple confirmation is
  // impossible in either direction). Passed into every confirmation edge; a
  // registry hit on an op's ack token is the exact "your commit's rows were
  // re-read" proof, strictly more precise than the watermark compare.
  const hasAck = useCallback(
    (txid: string) => txAcks.has(resource.key, paramsRef.current, txid),
    // paramsRef is a stable latest-ref handle; only the key participates.
    [resource.key, txAcks],
  );

  // Last `dataUpdateCount` this hook has already reconciled against. See the
  // subscription below — the gate that turns "the cache changed" into "a new
  // authoritative snapshot landed".
  const lastGenRef = useRef(0);

  // Subscribe to the TanStack QueryCache: every authoritative push (the WS path
  // does setQueryData → a `success` action for our exact key) runs the
  // confirmation pass and drops the resolved ops the server has absorbed.
  // No polling — this is push-driven by the cache itself.
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    // Re-baseline when the key changes: ops never outlive their (key, params).
    lastGenRef.current =
      queryClient.getQueryState<Data>(queryKeyRef.current)?.dataUpdateCount ??
      0;
    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      if (JSON.stringify(event.query.queryKey) !== targetKey) return;
      // A cache "updated" event does NOT mean a value arrived: query-core emits
      // one for EVERY state action (`fetch`, `error`, `invalidate`, `setState`,
      // …), all of which leave `state.data` untouched — still `undefined`
      // before the first value, or the previous snapshot after it. Only the
      // `success` action bumps `dataUpdateCount`, so an increase is the exact
      // "a push landed" signal.
      // Ungated, a plain refetch or invalidate would (a) coarse-confirm every
      // resolved op, (b) content-confirm an op against a snapshot the push has
      // not moved (an op the server has not applied yet would read as absorbed
      // or denied against stale truth), and (c) charge a divergence MISS for a
      // snapshot that never arrived — filing bogus stalled reports.
      //
      // `dataUpdateCount` is monotonic for a query's lifetime, and `useResource`
      // holds an observer for as long as this hook is mounted, so the cache
      // entry cannot be gc'd and recreated with a reset counter underneath us.
      const gen = event.query.state.dataUpdateCount;
      if (gen <= lastGenRef.current) return;
      lastGenRef.current = gen;
      if (pendingRef.current.length === 0) return;
      const serverData = event.query.state.data as Data | undefined;
      if (serverData === undefined) return;
      // The registry is written immediately BEFORE the setQueryData that fired
      // this event, so this synchronous read is the causal floor of exactly the
      // snapshot we are confirming against (Rule B′).
      const next = confirmPass(
        pendingRef.current,
        serverData,
        watermarks.get(resource.key, paramsRef.current),
        confirmationRef.current,
        hasAck,
      );
      reportOutcomes(next, "push");
      // `confirmPass` returns the input BY IDENTITY when nothing changed.
      if (next.pending !== pendingRef.current) commitPending(next.pending);
    });
    // The subscription stays mounted for the resource's lifetime and reads the
    // freshest confirmation off the stable `confirmationRef.current` at call time.
  }, [
    queryClient,
    targetKey,
    resource.key,
    commitPending,
    reportOutcomes,
    hasAck,
    watermarks,
  ]);

  // The ACK edge: a standalone `{ kind: "ack" }` frame produces NO cache event
  // (nothing changed byte-wise), so the QueryCache subscription above never
  // fires for it — this registry subscription is its delivery channel. Runs
  // `ackPass` only on a tuple match with ops pending; drops acked resolved ops
  // (unless the ordering rule blocks one behind an older same-target op),
  // counts no miss, denies nothing — so nothing to report but the confirm
  // latency of what it dropped. Value-frame ack notes fire this too; that
  // second pass is an identity no-op after the cache edge handled them.
  useEffect(() => {
    return txAcks.subscribe((key, params) => {
      if (key !== resource.key) return;
      if (ackParamsKey(params) !== ackParamsKey(paramsRef.current)) return;
      if (pendingRef.current.length === 0) return;
      const next = ackPass(
        pendingRef.current,
        hasAck,
        confirmationRef.current?.sameTarget,
      );
      reportOutcomes(next, "ack");
      // Identity when nothing changed — skip the state write.
      if (next.pending !== pendingRef.current) commitPending(next.pending);
    });
  }, [resource.key, hasAck, commitPending, reportOutcomes, txAcks]);

  const data = useMemo(
    // `applyRef` (stable useLatestRef handle) is read through `.current` at
    // compute time; recompute is intentionally keyed on base/pending only — apply
    // identity churn must NOT invalidate the overlay.
    /* eslint-disable react-hooks/refs -- intentional latest-reducer read inside the overlay memo (see above); the read is render-phase by design and the ref is stable */
    () =>
      base === undefined ? undefined : replay(base, pending, applyRef.current),
    /* eslint-enable react-hooks/refs */
    [base, pending],
  );

  // Fire (or re-fire) an op's `mutate`. Stable identity: dispatch, retry, and
  // the reconnect auto-retry all share it, reading the freshest mutate/onError
  // off their latest-refs. Returns the outcome so the failed-op drain can stop
  // when the transport is still down.
  //
  // This is the SEND ITSELF and knows nothing about ordering: every caller runs
  // it inside a send-lane slot (see `send-lane.ts`), so the lane is the one
  // mechanism and classification/`failed`/`retry`/`savedAt` stay untouched by it.
  const runMutate = useCallback(
    (opId: string, vars: Vars): Promise<MutateOutcome> => {
      // The wire departure — here, past the send lane, so a queued op's wait
      // is its `send-lane` phase and every retry (which re-enters here) moves
      // `lastSentAt`.
      commitPending(markSent(pendingRef.current, opId, performance.now()));
      return mutateRef.current(vars).then(
        (res) => {
          const ackedAt = performance.now();
          // Confirm against what the cache ALREADY holds: the confirming push
          // routinely lands ~1ms before this response (the change-feed pushes at
          // commit; the response waits on the handler's post-commit tail), and it
          // is the only push this write will ever generate.
          //
          // `state.data` is only a SNAPSHOT once an authoritative value has
          // landed (a params re-baseline can resolve an op before the new
          // tuple's base lands). Confirming against anything else — an empty
          // base "reflects" a remove, and vacuously absorbs an update-only
          // patch — would drop the op against data the server never sent.
          // `dataUpdatedAt` is 0 until the first real write (`useResource`
          // derives its own `pending` flag from exactly this), so gate on it.
          const state = queryClient.getQueryState<Data>(queryKeyRef.current);
          const hasAuthoritative = (state?.dataUpdatedAt ?? 0) > 0;
          const next = resolvePass(
            pendingRef.current,
            opId,
            ackedAt,
            hasAuthoritative ? state?.data : undefined,
            state?.dataUpdateCount ?? 0,
            watermarks.get(resource.key, paramsRef.current),
            res ? res.watermark : undefined,
            confirmationRef.current,
            // The exact-ack probe closes the delta-before-HTTP-response race:
            // the frame carrying this commit's ackTx may have landed (and been
            // noted) before this response — the registry remembers it.
            hasAck,
          );
          reportOutcomes(next, "resolve");
          commitPending(next.pending);
          // Stamp "saved" HERE — a persistent state value the sync-status store
          // observes, rather than an effect on a boolean React may coalesce away.
          // "Nothing failed" is implied: a failure only ever sits on an
          // UNRESOLVED op (mutate rejected ⇒ never resolved; a retry's resolve
          // clears it), so "no unresolved op remains" covers both.
          if (!next.pending.some((op) => !op.resolved)) {
            setSavedAt(Date.now());
          }
          return "resolved" as const;
        },
        (err: unknown) => {
          // A PERMANENT rejection is a final verdict: the server will never
          // hold this op's state, so it leaves the overlay now (the surface
          // renders server truth, and newer same-target ops stop parking behind
          // it) and is reported — the user is told, and a report is filed.
          if (
            err instanceof EndpointError &&
            classifyRejection(err.status) === "permanent"
          ) {
            commitPending(rejectOp(pendingRef.current, opId));
            const describe = describeOpRef.current;
            optimisticRejectionSink.emit({
              resourceKey: resource.key,
              params: paramsRef.current ?? null,
              label: labelRef.current ?? null,
              status: err.status,
              message: getEndpointErrorMessage(err).slice(
                0,
                REJECTION_MESSAGE_MAX,
              ),
              opSummary: describe ? describe(vars) : null,
            });
            if (onErrorRef.current)
              onErrorRef.current(err, vars, { opId, rejected: true });
            return "rejected" as const;
          }
          // Anything else is NOT a rollback: the op keeps rendering
          // (never-revert) and the failure kind drives the sync phase. A
          // transient server failure (`EndpointError`) surfaces as `error` +
          // manual Retry; anything else is a network-level failure (offline,
          // restarting server) — nothing is known to be wrong with the op, so
          // it stays `syncing` and auto-retries on the next reconnect edge.
          const failure: OpFailure =
            err instanceof EndpointError
              ? { kind: "http", status: err.status }
              : { kind: "network" };
          commitPending(markFailed(pendingRef.current, opId, failure));
          if (onErrorRef.current)
            onErrorRef.current(err, vars, { opId, rejected: false });
          return failure.kind;
        },
      );
    },
    // The latest-ref handles are stable; only these participate.
    [
      queryClient,
      resource.key,
      commitPending,
      reportOutcomes,
      hasAck,
      watermarks,
    ],
  );

  const dispatch = useCallback(
    (vars: Vars): string => {
      const opId = crypto.randomUUID();
      // The cache generation at dispatch. Tokenless coarse confirmation later
      // asks "did a push land after this?" — for consumers with no
      // `isConfirmedBy` and no ack token.
      const dispatchGen =
        queryClient.getQueryState<Data>(queryKeyRef.current)?.dataUpdateCount ??
        0;
      commitPending([
        ...pendingRef.current,
        {
          opId,
          vars,
          resolved: false,
          dispatchGen,
          misses: 0,
          divergenceReported: false,
          dispatchedAt: performance.now(),
          attempts: 0,
        },
      ]);
      // Onto the tuple's send lane, never straight at the network: this op's
      // predecessors must reach the server first. Head-of-line blocking is real
      // and deliberately invisible — the overlay above already rendered the op
      // (never-revert), so only its WIRE departure waits.
      void enqueueResourceSend(laneKeyRef.current, () => runMutate(opId, vars));
      return opId;
    },
    [queryClient, commitPending, runMutate, laneKeyRef],
  );

  // Re-fire a failed op IN PLACE: clear its failure and re-run its mutate under
  // the SAME opId — the op never leaves the overlay, so the rendered prediction
  // keeps its position (no remove/re-append flicker, no reorder). Returns the
  // outcome (undefined when the op is gone or not failed) for the drain below.
  const retryOp = useCallback(
    (opId: string): Promise<MutateOutcome> | undefined => {
      const op = pendingRef.current.find(
        (o) => o.opId === opId && o.failure !== undefined,
      );
      if (!op) return undefined;
      commitPending(clearFailure(pendingRef.current, opId));
      return runMutate(opId, op.vars);
    },
    [commitPending, runMutate],
  );
  const retry = useCallback(
    (opId: string) => {
      void enqueueResourceSend(laneKeyRef.current, async () => {
        await retryOp(opId);
      });
    },
    [retryOp, laneKeyRef],
  );

  // Single-flight drain of failed ops, in overlay order. The lane sequences the
  // sends — the drain's own job is the EARLY-STOP verdict: a `network` outcome
  // skips the rest of the batch (the transport is still down, so every later op
  // would fail the same way; a skipped op keeps its `failure`, so the next
  // reconnect edge — or the cloud's Retry — re-drains from the top). An `http`
  // outcome parks that op for manual Retry (a `rejected` one drops it) and the
  // batch keeps going, so later ops still get their in-order shot.
  //
  // The whole batch is enqueued SYNCHRONOUSLY rather than awaiting each op
  // before enqueuing the next: an await-loop would let a keystroke dispatched
  // mid-drain slot between two older ops it may causally depend on. Occupying
  // consecutive lane slots up front is what makes that impossible.
  const drainingRef = useRef(false);
  const drainFailed = useCallback(
    (kinds: ReadonlyArray<OpFailure["kind"]>) => {
      if (drainingRef.current) return;
      const opIds = pendingRef.current
        .filter(
          (op) => op.failure !== undefined && kinds.includes(op.failure.kind),
        )
        .map((op) => op.opId);
      if (opIds.length === 0) return;
      drainingRef.current = true;
      let stopped = false;
      const attempts = opIds.map((opId) =>
        enqueueResourceSend(laneKeyRef.current, async () => {
          if (stopped) return;
          const outcome = await retryOp(opId);
          if (outcome === "network") stopped = true;
        }),
      );
      void Promise.allSettled(attempts).then(() => {
        drainingRef.current = false;
      });
    },
    [retryOp, laneKeyRef],
  );

  // Auto-retry NETWORK-failed ops on reconnect edges (mirrors the Yjs
  // provider's offline-is-syncing policy — push-based, no timers, no per-push
  // retry):
  //  - the live-state socket for THIS resource's origin reopening (covers
  //    server restarts, where navigator.onLine never changed; HTTP and the WS
  //    ride the same gateway, so "socket reopened" implies endpoints are
  //    reachable again);
  //  - the browser's `online` event (covers actual connectivity loss, where an
  //    idle WS may not surface a close promptly).
  // HTTP-failed ops are deliberately excluded: the server already answered,
  // and nothing about a reconnect changes that answer — they wait for an
  // explicit `retry`.
  const retryNetworkFailed = useCallback(() => {
    drainFailed(["network"]);
  }, [drainFailed]);
  useEffect(() => {
    const socketKind = resource.origin === "central" ? "central" : "worktree";
    const unsubscribe = subscribeWsStatus((ev) => {
      if (ev.status !== "open" || socketKindOf(ev.url) !== socketKind) return;
      retryNetworkFailed();
    });
    const onOnline = () => retryNetworkFailed();
    window.addEventListener("online", onOnline);
    return () => {
      unsubscribe();
      window.removeEventListener("online", onOnline);
    };
  }, [resource.origin, retryNetworkFailed, socketKindOf]);

  const pendingOps = useMemo(
    () => pending.map((op) => ({ opId: op.opId, vars: op.vars })),
    [pending],
  );

  // "Saving" is UNRESOLVED ops only. `pending` also carries server-acked ops
  // awaiting their confirming push — counting those (the old `inFlight.length`)
  // is what pinned the cloud on "Saving…" forever.
  const saving = useMemo(() => pending.some((op) => !op.resolved), [pending]);

  // The HTTP-failed (transient) subset, derived from the overlay (failed ops
  // never left it). Network-failed ops are NOT failed — they are `syncing`.
  const failed = useMemo(
    () =>
      pending
        .filter((op) => op.failure?.kind === "http")
        .map((op) => ({ opId: op.opId, vars: op.vars })),
    [pending],
  );
  // Re-run only THIS hook's own failed ops — the SAME drain as the reconnect
  // edges (order dependence doesn't care why an op failed), widened to both
  // kinds so the cloud's Retry also nudges network-failed ops. Stable identity:
  // the indicator pulls it imperatively.
  const retryAll = useCallback(() => {
    drainFailed(["http", "network"]);
  }, [drainFailed]);

  // Re-fetch the RESOURCE (not an op) — the retry for a failing READ.
  const refetchRef = useLatestRef(result.refetch);
  const refetch = useCallback(() => refetchRef.current(), [refetchRef]);
  const retryLoad = useCallback(() => {
    void refetch();
  }, [refetch]);

  // Forced sync-status reporting: any optimistic surface lights up the universal
  // indicator with no indicator code of its own. Retry is wired to retryAll so
  // the indicator's Retry button re-runs only this hook's failed ops. A
  // network-failed op is unresolved, so it reports as `syncing` (the Yjs lane's
  // offline-is-syncing policy) — only a durable HTTP rejection is an `error`.
  //
  // A failing READ is an `error` too, and this is the ONLY place it can surface.
  // These surfaces are the sanctioned exemption to live-state's I1: they keep
  // painting last-known-good (`base` falls back to `result.stale`) instead of
  // blanking, which is right — but it means a durably-failing load is otherwise
  // INVISIBLE (a never-loaded surface shimmers its skeleton forever; a
  // once-loaded one silently serves stale rows). The exemption is only sound if
  // the failure it swallows comes out here, with a Retry that re-fetches.
  const loadFailed = resultError !== null;
  const phase =
    failed.length || loadFailed ? "error" : saving ? "syncing" : "idle";
  useReportSync({
    phase,
    label,
    retry: failed.length ? retryAll : loadFailed ? retryLoad : undefined,
    savedAt,
  });

  // Stable identity so the result can feed memo deps / combineResources gates.
  return useMemo(
    (): OptimisticResult<Data, Vars> =>
      base === undefined || data === undefined
        ? resultError === null
          ? { status: "loading", refetch }
          : { status: "error", error: resultError, refetch }
        : {
            status: "ready",
            data,
            serverData: base,
            error: resultError,
            refetch,
            dispatch,
            pendingOps,
            saving,
            failed,
            retry,
          },
    [
      data,
      base,
      resultError,
      refetch,
      dispatch,
      pendingOps,
      saving,
      failed,
      retry,
    ],
  );
}
