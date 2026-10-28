// The lane-only writes: a write joins a resource tuple's SEND LANE with no
// overlay. The lane itself — module-level, per `(resource.key, canonical
// params)`, failure-proof, synchronous when idle, reclaimed when idle — is
// `network/live`'s (`enqueueOnSendLane` / `resourceSendLaneKey`), shared with
// every other prediction system so writes to one tuple are ordered whoever
// issued them. What lives here is the naming of the tuple in this primitive's
// declaration-and-query forms (`resolveOptimisticSource`), the same forms
// `useOptimisticResource` reads.

import type {
  LiveAllCollection,
  LiveRowsCollection,
  LiveValue,
} from "@plugins/network/plugins/live/core";
import {
  enqueueOnSendLane,
  optimisticRejectionSink,
  REJECTION_MESSAGE_MAX,
  resourceSendLaneKey,
} from "@plugins/network/plugins/live/web";
import {
  EndpointAgentWriteRefusedError,
  EndpointError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import {
  resolveOptimisticSource,
  type OptimisticIdsQuery,
  type OptimisticScopedQuery,
} from "./source";

/**
 * Enqueue a write onto a resource tuple's send lane with NO overlay — for a
 * write whose surface is unmounted, or whose effect no single tuple's overlay
 * can predict. Ordering holds; there is nothing to predict.
 *
 * This exists because the lane registry is module-level: a page whose feed is
 * not mounted still HAS a lane, and a write aimed at it must depart after every
 * write already queued there. The alternative — a bare `fetch` — is not merely
 * unpredicted, it is UNORDERED, which is the property this primitive's ordered
 * fold depends on.
 *
 * The tuple is named exactly as `useOptimisticResource` names it — the same
 * declaration-and-query forms, resolved by the same `resolveOptimisticSource`
 * into the same `resourceSendLaneKey` — which is the whole point: a different
 * derivation would order the write against nothing.
 */
export function enqueueResourceWrite<T, Data, P extends Record<string, string>>(
  value: LiveValue<Data, P>,
  params: P | undefined,
  fn: () => Promise<T>,
): Promise<T>;
/** A scope of a collection declared `all: { by }` (`{ where }`). */
export function enqueueResourceWrite<T, Row, B extends string>(
  collection: LiveAllCollection<Row, B>,
  query: OptimisticScopedQuery<NoInfer<B>>,
  fn: () => Promise<T>,
): Promise<T>;
/** An id set of a collection (`{ ids }`, its `:rows` sibling). */
export function enqueueResourceWrite<T, Row>(
  collection: LiveRowsCollection<Row>,
  query: OptimisticIdsQuery,
  fn: () => Promise<T>,
): Promise<T>;
export function enqueueResourceWrite<T>(
  source: object,
  query: object | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const { resource, params } = resolveOptimisticSource(source, query);
  return enqueueOnSendLane(resourceSendLaneKey(resource.key, params), fn);
}

/**
 * What a detached write is, for the user and for the report: `label` names the
 * surface ("Page"), `describe` the write ("move"). `onRejected` runs after a
 * rejection is reported — the caller's cue to unwind side state it keyed on the
 * write (an undo entry), the twin of `useOptimisticResource`'s
 * `onError(…, { rejected: true })`.
 */
export interface DetachedWriteInfo {
  label: string;
  describe: string;
  onRejected?: () => void;
}

/**
 * `enqueueResourceWrite` for a FIRE-AND-FORGET write — the caller reads no
 * outcome, so the outcome cannot be left for the caller to surface. A detached
 * write has no overlay and no sync-status Retry, so a server rejection
 * (`EndpointError`, any status) would otherwise vanish: it is routed to
 * `optimisticRejectionSink`, which tells the user and files the report. Any
 * other failure (network, a bug) is rethrown — a deliberate unhandled
 * rejection, reported by the crash collector. Takes the same forms as
 * `enqueueResourceWrite`.
 */
export function enqueueDetachedWrite<Data, P extends Record<string, string>>(
  value: LiveValue<Data, P>,
  params: P | undefined,
  info: DetachedWriteInfo,
  fn: () => Promise<unknown>,
): void;
/** A scope of a collection declared `all: { by }` (`{ where }`). */
export function enqueueDetachedWrite<Row, B extends string>(
  collection: LiveAllCollection<Row, B>,
  query: OptimisticScopedQuery<NoInfer<B>>,
  info: DetachedWriteInfo,
  fn: () => Promise<unknown>,
): void;
/** An id set of a collection (`{ ids }`, its `:rows` sibling). */
export function enqueueDetachedWrite<Row>(
  collection: LiveRowsCollection<Row>,
  query: OptimisticIdsQuery,
  info: DetachedWriteInfo,
  fn: () => Promise<unknown>,
): void;
export function enqueueDetachedWrite(
  source: object,
  query: object | undefined,
  info: DetachedWriteInfo,
  fn: () => Promise<unknown>,
): void {
  const { resource, params } = resolveOptimisticSource(source, query);
  void enqueueOnSendLane(resourceSendLaneKey(resource.key, params), fn).catch(
    (err: unknown) => {
      if (!(err instanceof EndpointError)) throw err;
      optimisticRejectionSink.emit({
        resourceKey: resource.key,
        params: params ?? null,
        label: info.label,
        status: err.status,
        message: getEndpointErrorMessage(err).slice(0, REJECTION_MESSAGE_MAX),
        opSummary: info.describe,
        agentWriteRefused: err instanceof EndpointAgentWriteRefusedError,
      });
      if (info.onRejected) info.onRejected();
    },
  );
}
