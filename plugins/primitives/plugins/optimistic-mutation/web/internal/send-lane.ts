// The SEND LANE: every write for one `(resource.key, paramsKey)` tuple departs
// in the order it was issued.
//
// This primitive's model is `data = pendingOps.reduce(apply, serverTruth)` — an
// ordered fold. A consumer whose ops do not commute needs the server to apply
// them in the order they were issued, or server truth diverges from the
// prediction. Ordering is load-bearing: structural ops depend on their
// predecessors' server-side effects (a second split targets the block the first
// one created), so a concurrent send can land out of order and be durably
// rejected for a row that is merely not committed YET.
//
// The registry is MODULE-LEVEL, not a per-hook ref: two mounted hooks on the
// same tuple are two writers to ONE server-side entity, and a per-instance chain
// would order each of them against itself only — which is exactly the hole the
// page editor's own `writeChainRef` had. Module scope is also what lets
// `enqueueResourceWrite` order a write for a tuple with NO mounted hook at all.

import type {
  LiveAllCollection,
  LiveRowsCollection,
  LiveValue,
} from "@plugins/network/plugins/live/core";
import {
  EndpointError,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { optimisticRejectionSink, REJECTION_MESSAGE_MAX } from "../reporter";
import {
  resolveOptimisticSource,
  type OptimisticIdsQuery,
  type OptimisticScopedQuery,
} from "./source";

/** One tuple's lane: the tail to chain onto, and how many sends are unsettled. */
interface Lane {
  tail: Promise<unknown>;
  depth: number;
}

const lanes = new Map<string, Lane>();

/**
 * The lane key for a resource tuple. Canonical (sorted-key JSON), so two mounts
 * that build their `params` object in different key orders still share one lane.
 *
 * Deliberately its own derivation rather than the hook's `ackParamsKey`, which
 * must stay byte-identical to the live-state registries' key: this one only has
 * to be SELF-consistent, and coupling it to a foreign wire format would make the
 * lane's identity someone else's to change.
 */
export function sendLaneKey(
  resourceKey: string,
  params: Record<string, string> | undefined,
): string {
  if (!params) return `${resourceKey}|{}`;
  const obj: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) obj[k] = params[k]!;
  return `${resourceKey}|${JSON.stringify(obj)}`;
}

/**
 * Run `send` after every send already queued on this tuple's lane, and return
 * its own outcome verbatim — so the caller's classification, retry and
 * never-revert handling are untouched by the queuing.
 *
 * The lane is FAILURE-PROOF: it advances on settle, resolve or reject alike, so
 * a durably-rejected send can never wedge its successors.
 *
 * An IDLE lane sends synchronously — there is nothing to wait for, so the lane
 * must add neither latency nor a microtask of skew to a write that has no
 * predecessor. A synchronous throw out of `send` therefore still propagates to
 * the caller on that path, exactly as an unqueued call would.
 */
export function enqueueResourceSend<T>(
  laneKey: string,
  send: () => Promise<T>,
): Promise<T> {
  const existing = lanes.get(laneKey);
  if (existing === undefined) {
    const run = send();
    const lane: Lane = { tail: run, depth: 1 };
    lanes.set(laneKey, lane);
    trackSettle(laneKey, lane, run);
    return run;
  }
  existing.depth += 1;
  // `.then(send, send)` — the successor runs on BOTH edges. This is the whole
  // failure-proofing: a rejected predecessor advances the lane like any other.
  const run = existing.tail.then(send, send);
  existing.tail = run;
  trackSettle(laneKey, existing, run);
  return run;
}

/**
 * Reclaim an idle lane. A module-level registry keyed by a string would
 * otherwise retain one entry per tuple ever written — an unbounded leak as pages
 * are opened. A lane with nothing unsettled holds no ordering constraint, so
 * dropping it is free: the next send finds no lane, creates a fresh one, and
 * departs immediately — which is the correct order, there being nothing in
 * flight to order it against.
 */
function trackSettle(laneKey: string, lane: Lane, run: Promise<unknown>): void {
  const done = (): void => {
    lane.depth -= 1;
    if (lane.depth === 0 && lanes.get(laneKey) === lane) lanes.delete(laneKey);
  };
  void run.then(done, done);
}

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
 * into the same `sendLaneKey` — which is the whole point: a different
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
  return enqueueResourceSend(sendLaneKey(resource.key, params), fn);
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
  void enqueueResourceSend(sendLaneKey(resource.key, params), fn).catch(
    (err: unknown) => {
      if (!(err instanceof EndpointError)) throw err;
      optimisticRejectionSink.emit({
        resourceKey: resource.key,
        params: params ?? null,
        label: info.label,
        status: err.status,
        message: getEndpointErrorMessage(err).slice(0, REJECTION_MESSAGE_MAX),
        opSummary: info.describe,
      });
      if (info.onRejected) info.onRejected();
    },
  );
}

/** Occupied lanes. Test-only introspection — pins the reclamation above. */
export function activeSendLaneCount(): number {
  return lanes.size;
}
