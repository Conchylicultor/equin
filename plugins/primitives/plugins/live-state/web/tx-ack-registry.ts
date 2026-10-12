// Client-side registry of the source-transaction ids (`ackTx`) the server has
// acknowledged per (key, params) — the exact-ack half of optimistic
// confirmation (Part C of
// research/2026-07-18-global-bounded-working-set-phase2.md). Populated by
// `NotificationsClient` from every frame that carries `ackTx`: value frames
// (`update` / keyed `delta`, noted immediately BEFORE the cache write they
// describe — the same load-bearing order as the watermark registry, so a
// QueryCache listener reading `hasResourceTxAck` synchronously sees the acks of
// exactly the snapshot it was handed) and standalone `{ kind: "ack" }` frames
// (no cache write at all — the subscription channel below is how the optimistic
// hook learns about those).
//
// The claim `hasResourceTxAck(key, params, W)` makes is narrow and sound: "for
// this tuple, every row transaction W wrote has been re-read post-commit and is
// reflected in the merged base". It can CONFIRM the pending op whose ack token
// equals W; it can never deny (denial stays snapshot-watermark-only — Rule B′
// coexists unchanged).
//
// One registry per live-state pipeline, exactly like `watermark-registry.ts`:
// the free functions below read and write the page's own (`rootTxAcks`) — the
// optimistic hook reads it synchronously inside QueryCache callbacks, and jsdom
// tests exercise the overlay machine without a NotificationsProvider — and a
// scoped pipeline gets its own. Per-tuple insertion-order ring, bounded at
// ACK_RING_CAP — old acks age out; a missed (evicted) ack is safe, the sub-ack
// watermark backstop confirms.

type ResourceParams = Record<string, string>;

// Per-(key, paramsKey) insertion-order ring cap. 256 comfortably exceeds any
// plausible number of in-flight mutations per tuple; beyond it the oldest acks
// age out (safe — watermark backstop).
const ACK_RING_CAP = 256;

interface AckRing {
  /** Insertion order — the eviction queue. */
  list: string[];
  /** Same ids — the O(1) membership index. */
  set: Set<string>;
}

type AckListener = (key: string, params: ResourceParams | undefined) => void;

// Canonical params serialization — byte-identical to `paramsKey` in
// notifications-client.ts (sorted-key JSON), so `${key}\0${paramsKey}` here
// names exactly the same subscription id.
function paramsKey(params: ResourceParams | undefined): string {
  if (!params) return "{}";
  const keys = Object.keys(params).sort();
  const obj: ResourceParams = {};
  for (const k of keys) obj[k] = params[k]!;
  return JSON.stringify(obj);
}

function registryId(key: string, params: ResourceParams | undefined): string {
  return `${key}\0${paramsKey(params)}`;
}

export interface TxAckRegistry {
  note(
    key: string,
    params: ResourceParams | undefined,
    txids: readonly string[],
  ): void;
  has(key: string, params: ResourceParams | undefined, txid: string): boolean;
  subscribe(listener: AckListener): () => void;
}

export function createTxAckRegistry(): TxAckRegistry {
  const rings = new Map<string, AckRing>();
  const listeners = new Set<AckListener>();
  return {
    note(key, params, txids) {
      if (txids.length === 0) return;
      const id = registryId(key, params);
      let ring = rings.get(id);
      if (!ring) {
        ring = { list: [], set: new Set() };
        rings.set(id, ring);
      }
      for (const txid of txids) {
        if (ring.set.has(txid)) continue;
        ring.list.push(txid);
        ring.set.add(txid);
        if (ring.list.length > ACK_RING_CAP) {
          const evicted = ring.list.shift()!;
          ring.set.delete(evicted);
        }
      }
      for (const fn of listeners) fn(key, params);
    },
    has(key, params, txid) {
      return rings.get(registryId(key, params))?.set.has(txid) ?? false;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The page's own pipeline's registry. */
export const rootTxAcks = createTxAckRegistry();

/**
 * Record the server-acknowledged source-transaction ids for (key, params), then
 * notify subscribers (emit-after-note: a listener reading `hasResourceTxAck`
 * inside its callback already sees the freshly-noted acks). Duplicate ids are
 * no-ops; the per-tuple ring evicts oldest-first past ACK_RING_CAP.
 */
export function noteResourceTxAcks(
  key: string,
  params: ResourceParams | undefined,
  txids: readonly string[],
): void {
  rootTxAcks.note(key, params, txids);
}

/**
 * Has the server acknowledged transaction `txid` for (key, params)? False for
 * a never-noted tuple, an evicted (aged-out) ack, or a different tuple's ack —
 * the registry is namespaced per (key, paramsKey), so a wrong-tuple
 * confirmation is impossible in either direction.
 */
export function hasResourceTxAck(
  key: string,
  params: ResourceParams | undefined,
  txid: string,
): boolean {
  return rootTxAcks.has(key, params, txid);
}

/**
 * Subscribe to ack notes. The listener fires AFTER the acks are noted (so a
 * synchronous `hasResourceTxAck` read inside it sees them), with the (key,
 * params) of the noted tuple. This is the delivery channel for standalone
 * `{ kind: "ack" }` frames, which produce NO cache event — for value frames the
 * QueryCache subscription observes the accompanying cache write anyway, and a
 * second pass is an identity no-op.
 */
export function subscribeResourceTxAcks(listener: AckListener): () => void {
  return rootTxAcks.subscribe(listener);
}
