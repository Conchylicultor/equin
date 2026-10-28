import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  EndpointAgentWriteRefusedError,
  EndpointError,
  endpointContractOf,
  unavailableMessage,
  type EndpointDef,
  type MachineEndpointDef,
  type MachineUnavailable,
  type PredictedEndpointDef,
  type PredictedMachineEndpointDef,
  type WriteEndpoint,
} from "@plugins/infra/plugins/endpoints/core";
import {
  getEndpointErrorMessage,
  useFetchEndpoint,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import {
  subscribeWsStatus,
  transportScoped,
  useTransport,
  useTransportScoped,
} from "@plugins/primitives/plugins/networking/web";
import {
  clientLatencySink,
  splitPhases,
  splitReachedPhases,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  readLiveEffect,
  type ResolvedLiveTarget,
} from "@plugins/network/plugins/live/core";
import type {
  PredictFailure,
  PredictOp,
  PredictStore,
} from "./predict-overlay";
import { predictStores } from "./use-predicted";
import {
  enqueueOnSendLane,
  entitySendLaneKey,
  type SendLaneKey,
} from "./send-lane";
import {
  armUnconfirmedDeadline,
  type UnconfirmedDeadline,
  type UnconfirmedSample,
} from "./unconfirmed-deadline";
import {
  classifyRejection,
  optimisticRejectionSink,
  REJECTION_MESSAGE_MAX,
} from "./write-sinks";
import { hiddenSince } from "./tab-hidden";

// `useLiveMutation` — the one browser client of a PREDICTED endpoint (one
// declared with an `effect`): design in
// research/2026-10-27-global-predicted-endpoint-effects.md §3–4.
//
// `mutate(req)` applies the effect to the predict overlay at once (every live
// read of the target rows shows it on the next render), then sends the write
// on the first target's send lane. There is no pending state and no promise —
// so no spinner, no "Closing…" label and no `Button` auto-pend can be written
// over a predicted write. What the user is told instead:
//
// - the sync cloud (`sync-status`): syncing while a write this hook sent is
//   un-acked, error + Retry when the server failed it transiently;
// - a permanent 4xx (`classifyRejection`): the op leaves the overlay (the
//   reads show server truth again) and is emitted on `optimisticRejectionSink`,
//   whose collector toasts and files the report — never-revert holds for every
//   other failure;
// - the deadline: an op not DONE (acked and confirmed by every tuple holding
//   its rows) within `confirmWithinMs ?? UNCONFIRMED_MS` files a CENSORED
//   `confirm` latency sample; a done one files the complete sample (variant
//   `predict/<route>`), which `debug/slow-ops` reports when slow.
//
// The op's lifecycle is the transport's WRITER's, not the hook's: a button
// that unmounts on click (a menu item, a thread's End) still has its write
// sent, retried on reconnect, confirmed and timed.

/** A write's request, shaped like `useEndpointMutation`'s variables. */
export type LiveMutationRequest<TParams, TBody> =
  TParams extends Record<string, never>
    ? TBody extends void
      ? { params?: TParams; body?: never }
      : { params?: TParams; body: TBody }
    : TBody extends void
      ? { params: TParams; body?: never }
      : { params: TParams; body: TBody };

export interface LiveMutationOptions<TParams, TBody, TResponse> {
  /**
   * The server accepted the write (2xx) — for what depends on its ANSWER (a
   * toast keyed on a server-decided field). Runs even when the calling
   * component has unmounted since.
   */
  onSuccess?: (
    response: TResponse,
    req: LiveMutationRequest<TParams, TBody>,
  ) => void;
  /**
   * The send failed. `rejected`: the server refused it for good (a 4xx) and
   * the prediction is already gone — the user has been told (the rejection
   * toast); unwind any side state keyed on it, do not toast again. Otherwise
   * it stays applied and is retried (never-revert).
   */
  onError?: (
    error: unknown,
    req: LiveMutationRequest<TParams, TBody>,
    outcome: { rejected: boolean },
  ) => void;
  /** Names the thing written, in the cloud's error state and the rejection toast. */
  label?: string;
}

/**
 * A predicted endpoint's client: `mutate(req)` and nothing else — it returns
 * nothing and exposes no pending state. A desktop-only endpoint
 * (`needsMachine`) answers `{ kind: "unavailable", message }` under a
 * transport with no computer behind it; a portable one is always
 * `available` (one shape either way).
 */
export interface LiveMutation<TParams, TBody> {
  readonly kind: "available";
  readonly mutate: (req: LiveMutationRequest<TParams, TBody>) => void;
}

/** What a dispatched write needs from its caller, past the effect. */
interface DispatchSpec {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly targets: readonly ResolvedLiveTarget[];
  readonly confirmWithinMs: number | undefined;
  readonly label: string | null;
  /** One attempt at the wire; resolves with the response. */
  readonly send: () => Promise<unknown>;
  readonly onAcked: (response: unknown) => void;
  readonly onFailed: (error: unknown, rejected: boolean) => void;
  /** The op left the overlay (done or rejected). */
  readonly onLeft: () => void;
}

interface Entry {
  readonly spec: DispatchSpec;
  readonly lane: SendLaneKey;
  readonly deadline: UnconfirmedDeadline | null;
}

/** The transport's predicted-write lifecycle: send, retry, reject, confirm, time. */
interface PredictWriter {
  readonly store: PredictStore;
  dispatch(spec: DispatchSpec): string;
  /** Re-send these failed ops, in dispatch order, each on its lane. */
  retry(opIds: readonly string[]): void;
}

function createPredictWriter(
  store: PredictStore,
  telemetry: boolean,
): PredictWriter {
  const entries = new Map<string, Entry>();
  let reconnect: (() => void) | null = null;

  const leave = (opId: string): void => {
    const entry = entries.get(opId);
    if (entry === undefined) return;
    entries.delete(opId);
    entry.deadline?.clear();
    entry.spec.onLeft();
  };

  const attempt = (opId: string): Promise<void> => {
    const entry = entries.get(opId);
    // Left the overlay (rejected, or done) while queued behind the lane.
    if (entry === undefined) return Promise.resolve();
    const sentAt = performance.now();
    store.update(opId, (op) => ({
      ...op,
      failure: undefined,
      firstSentAt: op.firstSentAt ?? sentAt,
      lastSentAt: sentAt,
    }));
    return entry.spec.send().then(
      (response) => {
        const ackedAt = performance.now();
        store.update(opId, (op) => ({ ...op, ackedAt }));
        // The confirming push routinely lands before the response: the ack
        // may complete the op right here.
        store.sweep();
        entry.spec.onAcked(response);
      },
      (err: unknown) => {
        if (
          err instanceof EndpointError &&
          classifyRejection(err.status) === "permanent"
        ) {
          store.remove(opId);
          leave(opId);
          optimisticRejectionSink.emit({
            resourceKey: entry.spec.route,
            params: entry.spec.params,
            label: entry.spec.label,
            status: err.status,
            message: getEndpointErrorMessage(err).slice(
              0,
              REJECTION_MESSAGE_MAX,
            ),
            opSummary: null,
            agentWriteRefused: err instanceof EndpointAgentWriteRefusedError,
          });
          entry.spec.onFailed(err, true);
          return;
        }
        // Never-revert: the prediction stays. A transient server failure
        // waits for the user's Retry; a network one retries on reconnect.
        const failure: PredictFailure =
          err instanceof EndpointError
            ? { kind: "http", status: err.status }
            : { kind: "network" };
        store.update(opId, (op) => ({ ...op, failure }));
        if (failure.kind === "network") watchReconnect();
        entry.spec.onFailed(err, false);
      },
    );
  };

  const retry = (opIds: readonly string[]): void => {
    for (const opId of opIds) {
      const entry = entries.get(opId);
      if (entry === undefined || store.op(opId)?.failure === undefined)
        continue;
      void enqueueOnSendLane(entry.lane, () => attempt(opId));
    }
  };

  /**
   * Re-send the network-failed ops on the next reconnect edge — the socket
   * reopening (a server restart) or the browser's `online` — push-based, held
   * only while such an op exists.
   */
  const watchReconnect = (): void => {
    if (reconnect !== null) return;
    const fire = (): void => {
      const failed = store
        .ops()
        .filter((op) => op.failure?.kind === "network")
        .map((op) => op.opId);
      if (failed.length === 0) {
        stop();
        return;
      }
      retry(failed);
    };
    const unsubscribe = subscribeWsStatus((ev) => {
      if (ev.status === "open") fire();
    });
    window.addEventListener("online", fire);
    const stop = (): void => {
      unsubscribe();
      window.removeEventListener("online", fire);
      reconnect = null;
    };
    reconnect = stop;
  };

  return {
    store,
    dispatch(spec) {
      const first = spec.targets[0];
      if (first === undefined) {
        throw new Error(
          `useLiveMutation(${spec.route}): the effect resolved to no target — a predicted write names the rows it changes.`,
        );
      }
      const firstId = first.kind === "row" ? first.id : first.ids[0];
      if (firstId === undefined) {
        throw new Error(
          `useLiveMutation(${spec.route}): an applyRows target names no row id.`,
        );
      }
      const opId = crypto.randomUUID();
      const op: PredictOp = {
        opId,
        route: spec.route,
        params: spec.params,
        targets: spec.targets,
        entities: new Set(spec.targets.map((t) => t.entity)),
        dispatchedAt: performance.now(),
        retired: new Set(),
      };
      const deadline = telemetry
        ? armUnconfirmedDeadline({
            ...(spec.confirmWithinMs === undefined
              ? {}
              : { deadlineMs: spec.confirmWithinMs }),
            sample: () => {
              const now = store.op(opId);
              // Cleared on every exit, so a firing deadline's op is in flight.
              if (now === undefined) {
                throw new Error(
                  `useLiveMutation(${spec.route}): the unconfirmed deadline fired for op ${opId}, which left the overlay`,
                );
              }
              return unconfirmedSample(now, performance.now());
            },
          })
        : null;
      entries.set(opId, {
        spec,
        lane: entitySendLaneKey(first.entity, firstId),
        deadline,
      });
      store.add(op, (done, doneAt) => {
        leave(opId);
        if (telemetry && clientLatencySink.hasSubscribers()) {
          clientLatencySink.emit(confirmSample(done, doneAt));
        }
      });
      void enqueueOnSendLane(entries.get(opId)!.lane, () => attempt(opId));
      return opId;
    },
    retry,
  };
}

/**
 * The complete `confirm` sample of a DONE op: its lane wait, its retries, the
 * server's ack and the confirming frame (`confirm-frame`: from the ack to the
 * tuples agreeing), on `performance.now()`. A done op was acked, and an acked
 * op was sent — a missing stamp is a lifecycle bug, so it throws.
 */
function confirmSample(op: PredictOp, doneAt: number) {
  const { dispatchedAt, firstSentAt, lastSentAt, ackedAt } = op;
  if (
    firstSentAt === undefined ||
    lastSentAt === undefined ||
    ackedAt === undefined
  ) {
    throw new Error(
      `useLiveMutation(${op.route}): op ${op.opId} is done but missing a send/ack stamp`,
    );
  }
  return {
    signal: "confirm" as const,
    key: op.route,
    params: op.params,
    variant: `predict/${op.route}`,
    phases: splitPhases("confirm", {
      "send-lane": firstSentAt - dispatchedAt,
      retry: lastSentAt - firstSentAt,
      "server-ack": ackedAt - lastSentAt,
      "confirm-frame": doneAt - ackedAt,
    }),
    totalMs: doneAt - dispatchedAt,
    hidden: hiddenSince(dispatchedAt),
  };
}

/**
 * The CENSORED `confirm` sample of an op still not done at its deadline: the
 * phases it reached and the time since dispatch; the variant names the part
 * that stalled — `awaiting-send` (queued behind its lane), `awaiting-ack`
 * (sent, no 2xx yet, or failed and awaiting a retry) or
 * `awaiting-confirm-frame` (acked, a tuple holding its row still disagrees).
 */
function unconfirmedSample(op: PredictOp, now: number): UnconfirmedSample {
  const { dispatchedAt, firstSentAt, lastSentAt, ackedAt } = op;
  const stage =
    firstSentAt === undefined
      ? "awaiting-send"
      : ackedAt === undefined
        ? "awaiting-ack"
        : "awaiting-confirm-frame";
  return {
    signal: "confirm",
    censored: true,
    key: op.route,
    params: op.params,
    variant: `predict/${op.route}/unconfirmed/${stage}`,
    phases: splitReachedPhases("confirm", {
      "send-lane":
        firstSentAt === undefined ? undefined : firstSentAt - dispatchedAt,
      retry:
        firstSentAt === undefined || lastSentAt === undefined
          ? undefined
          : lastSentAt - firstSentAt,
      "server-ack":
        ackedAt === undefined || lastSentAt === undefined
          ? undefined
          : ackedAt - lastSentAt,
    }),
    totalMs: now - dispatchedAt,
    hidden: hiddenSince(dispatchedAt),
  };
}

/** One writer per transport, over that transport's overlay. */
const writers = transportScoped<PredictWriter>((transport) =>
  createPredictWriter(predictStores.of(transport), transport.telemetry),
);

type AnyPredicted =
  | PredictedEndpointDef<string, unknown, unknown, unknown, unknown>
  | PredictedMachineEndpointDef<string, unknown, unknown, unknown, unknown>;

/**
 * The client of a predicted endpoint (`defineEndpoint({ …, effect })`) — see
 * the header. `opts` is read at call time (a fresh object per render is fine).
 */
export function useLiveMutation<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: PredictedMachineEndpointDef<
    Route,
    TParams,
    TBody,
    TResponse,
    TQuery
  >,
  opts?: LiveMutationOptions<TParams, TBody, TResponse>,
): LiveMutation<TParams, TBody> | MachineUnavailable;
export function useLiveMutation<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: PredictedEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  opts?: LiveMutationOptions<TParams, TBody, TResponse>,
): LiveMutation<TParams, TBody>;
export function useLiveMutation(
  endpoint: AnyPredicted,
  opts?: LiveMutationOptions<unknown, unknown, unknown>,
): LiveMutation<unknown, unknown> | MachineUnavailable {
  const transport = useTransport();
  const writer = useTransportScoped(writers);
  const fetchEndpoint = useFetchEndpoint();
  const optsRef = useLatestRef(opts);

  // This hook's ops — what its sync report is about.
  const [mine, setMine] = useState<readonly string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { store } = writer;
  const ops = useSyncExternalStore(store.subscribe, store.ops);

  const mutate = useCallback(
    (req: LiveMutationRequest<unknown, unknown>): void => {
      const r = req as { params?: unknown; body?: unknown };
      const params = (r.params ?? {}) as Record<string, string>;
      const resolved = readLiveEffect(
        endpoint.effect as Parameters<typeof readLiveEffect>[0],
      ).resolve({ params, body: r.body });
      const opId = writer.dispatch({
        route: endpoint.route,
        params,
        targets: resolved.targets,
        confirmWithinMs: resolved.confirmWithinMs,
        label: optsRef.current?.label ?? null,
        send: () => sendOnce(fetchEndpoint, endpoint, params, r.body),
        onAcked: (response) => {
          setSavedAt(Date.now());
          optsRef.current?.onSuccess?.(response, req);
        },
        onFailed: (error, rejected) => {
          optsRef.current?.onError?.(error, req, { rejected });
        },
        onLeft: () => setMine((m) => m.filter((id) => id !== opId)),
      });
      setMine((m) => [...m, opId]);
    },
    [endpoint, writer, fetchEndpoint, optsRef],
  );

  // Sync status: syncing while a write of this hook is un-acked (a network
  // failure included — it retries on reconnect), error while one failed
  // transiently (Retry re-sends it).
  const own = ops.filter((op) => mine.includes(op.opId));
  const failed = own
    .filter((op) => op.failure?.kind === "http")
    .map((op) => op.opId);
  // `useReportSync` holds `retry` in a ref: a fresh closure is fine.
  const retry = (): void => writer.retry(failed);
  useReportSync({
    phase:
      failed.length > 0
        ? "error"
        : own.some((op) => op.ackedAt === undefined)
          ? "syncing"
          : "idle",
    ...(opts?.label === undefined ? {} : { label: opts.label }),
    retry: failed.length > 0 ? retry : undefined,
    savedAt,
  });

  const { needsMachine } = endpoint;
  return useMemo(
    (): LiveMutation<unknown, unknown> | MachineUnavailable =>
      needsMachine !== undefined && !transport.machine
        ? { kind: "unavailable", message: unavailableMessage(needsMachine) }
        : { kind: "available", mutate },
    [needsMachine, transport.machine, mutate],
  );
}

/** One wire attempt through the subtree's `FetchEndpoint`, the effect stripped. */
async function sendOnce(
  fetchEndpoint: FetchEndpoint,
  endpoint: AnyPredicted,
  params: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  // Erased like the def: the overloads typed `body` against the route's.
  const opts = (
    body === undefined ? {} : { body }
  ) as Parameters<FetchEndpoint>[2];
  // Internal dispatch over an erased def (a predicted def is a write by
  // construction: `effect` is `never` on a read); callers are typed by the
  // overloads.
  if (endpoint.needsMachine === undefined) {
    return fetchEndpoint(
      endpointContractOf(endpoint) as EndpointDef<
        string,
        unknown,
        unknown,
        unknown,
        unknown
      > &
        WriteEndpoint,
      params,
      opts,
    );
  }
  const result = await fetchEndpoint(
    endpointContractOf(endpoint) as MachineEndpointDef<
      string,
      unknown,
      unknown,
      unknown,
      unknown
    > &
      WriteEndpoint,
    params,
    opts,
  );
  // Unreachable: `mutate` is handed out only under a transport with the
  // computer behind it, and a subtree's transport is fixed.
  if (result.kind === "unavailable") throw new Error(result.message);
  return result.value;
}
