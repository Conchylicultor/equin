// The SEND LANE: every write aimed at one lane key departs in the order it was
// issued.
//
// A client prediction is an ordered fold (`data = pendingOps.reduce(apply,
// serverTruth)`). A consumer whose ops do not commute needs the server to apply
// them in the order they were issued, or server truth diverges from the
// prediction. Ordering is load-bearing: structural ops depend on their
// predecessors' server-side effects (a second split targets the block the first
// one created), so a concurrent send can land out of order and be durably
// rejected for a row that is merely not committed YET.
//
// The registry is MODULE-LEVEL, not a per-hook ref: two mounted writers on the
// same target are two writers to ONE server-side entity, and a per-instance
// chain would order each of them against itself only. Module scope is also what
// lets a write be ordered for a target with NO mounted reader at all.
//
// It lives in `network/live` (not `optimistic-mutation`, which imports this
// plugin) so every prediction system — `useOptimisticResource`'s overlay, its
// detached writes, and the predicted endpoint effects — shares ONE registry:
// writes to the same lane key are ordered against each other whoever issued
// them.

declare const sendLaneKeyBrand: unique symbol;

/**
 * A send lane's identity. Branded, so a lane is only ever named through one of
 * the two derivations below — a hand-built string cannot alias (or miss) a lane
 * another writer derives.
 */
export type SendLaneKey = string & { readonly [sendLaneKeyBrand]: true };

/** One lane: the tail to chain onto, and how many sends are unsettled. */
interface Lane {
  tail: Promise<unknown>;
  depth: number;
}

const lanes = new Map<SendLaneKey, Lane>();

/**
 * The lane of a resource TUPLE `(resource.key, params)`. Canonical (sorted-key
 * JSON), so two mounts that build their `params` object in different key orders
 * still share one lane.
 *
 * Deliberately its own derivation rather than the live-state registries'
 * `paramsKey`: this one only has to be SELF-consistent, and coupling it to a
 * foreign wire format would make the lane's identity someone else's to change.
 */
export function resourceSendLaneKey(
  resourceKey: string,
  params: Readonly<Record<string, string>> | undefined,
): SendLaneKey {
  if (!params) return `r|${resourceKey}|{}` as SendLaneKey;
  const obj: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) obj[k] = params[k]!;
  return `r|${resourceKey}|${JSON.stringify(obj)}` as SendLaneKey;
}

/**
 * The lane of one entity ROW `(entityName, rowId)` — for a write whose target is
 * a row of an entity rather than one resource tuple (a predicted endpoint
 * effect, which every collection over that entity reflects). Namespaced apart
 * from `resourceSendLaneKey`, so the two derivations can never collide.
 */
export function entitySendLaneKey(
  entityName: string,
  rowId: string,
): SendLaneKey {
  return `e|${entityName}|${rowId}` as SendLaneKey;
}

/**
 * Run `send` after every send already queued on this lane, and return its own
 * outcome verbatim — so the caller's classification, retry and never-revert
 * handling are untouched by the queuing.
 *
 * The lane is FAILURE-PROOF: it advances on settle, resolve or reject alike, so
 * a durably-rejected send can never wedge its successors.
 *
 * An IDLE lane sends synchronously — there is nothing to wait for, so the lane
 * must add neither latency nor a microtask of skew to a write that has no
 * predecessor. A synchronous throw out of `send` therefore still propagates to
 * the caller on that path, exactly as an unqueued call would.
 */
export function enqueueOnSendLane<T>(
  laneKey: SendLaneKey,
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
 * otherwise retain one entry per target ever written — an unbounded leak as
 * pages are opened. A lane with nothing unsettled holds no ordering constraint,
 * so dropping it is free: the next send finds no lane, creates a fresh one, and
 * departs immediately — which is the correct order, there being nothing in
 * flight to order it against.
 */
function trackSettle(
  laneKey: SendLaneKey,
  lane: Lane,
  run: Promise<unknown>,
): void {
  const done = (): void => {
    lane.depth -= 1;
    if (lane.depth === 0 && lanes.get(laneKey) === lane) lanes.delete(laneKey);
  };
  void run.then(done, done);
}

/** Occupied lanes. Test-only introspection (`web/testing`) — pins the reclamation above. */
export function activeSendLaneCount(): number {
  return lanes.size;
}
