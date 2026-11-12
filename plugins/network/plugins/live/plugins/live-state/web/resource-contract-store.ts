import { useSyncExternalStore } from "react";
import { canonicalJson } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import type {
  ContractVerdict,
  SubErrorReason,
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";

// Which resources the server currently refuses for this tab as not speaking
// their contract — a subscription (or its HTTP read) refused as
// `contract-mismatch` or `unknown-key` — or whose pushed value this tab's
// schema rejects against a server on another build (a `ResourceDecodeError`
// judged `skew`, recorded as `contract-mismatch`: the same fact, seen from the
// tab's side). With a `skew` verdict the tab's bundle
// and the server's code come from different builds, so the app-wide advice
// reads it (build's `useReloadAdvice`): one surface for every resource, instead
// of each read rendering its own permanent failure. WHICH side is behind is
// not this store's question — the advice answers it from the deployment.
//
// A refusal stands per TUPLE until that tuple is answered: the transport clears
// it on every applied value (`clearResourceContractMismatch`). A tab that is
// itself out of date is never answered, so its refusals stand until it reloads;
// a server that was behind and caught up (a backend restarted onto the build
// this tab already runs) answers the replayed subs, and the advice goes away
// without a reload it could not have helped with.
//
// Module-level, page-global: the transport (`NotificationsClient`) writes it
// from both the WS `sub-error` frame and a failed HTTP read's typed body.

export interface ResourceContractMismatch {
  key: string;
  reason: Extract<SubErrorReason, "contract-mismatch" | "unknown-key">;
  /** Absent from a server that predates verdicts — never read as `skew`. */
  verdict?: ContractVerdict;
}

type Params = Readonly<Record<string, string>>;

const byTuple = new Map<string, ResourceContractMismatch>();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: the one NotificationsClient per page (the single writer) learns which tuples the server refuses THIS BUNDLE — a fact about the page's code against the server's, identical for every keep-alive/desktop surface mount, exactly like the sibling deferred-load store the same Reload advice reads. A per-surface store would be semantically wrong. This is the per-key snapshot of the `byTuple` map above, rebuilt only when it changes so useSyncExternalStore reads a stable reference.
let perKey: readonly ResourceContractMismatch[] = [];
const listeners = new Set<() => void>();

function tupleId(key: string, params: Params): string {
  return `${key}\0${canonicalJson(params)}`;
}

/**
 * One entry per resource key (the advice counts resources, not tuples): the
 * most recently refused tuple's reason and verdict stand for the key.
 */
function rebuild(): void {
  const keys = new Map<string, ResourceContractMismatch>();
  for (const m of byTuple.values()) {
    keys.delete(m.key);
    keys.set(m.key, m);
  }
  perKey = [...keys.values()];
  for (const l of listeners) l();
}

/** Record that the server refused `key` at `params` for this tab. Idempotent per identical entry. */
export function markResourceContractMismatch(
  entry: ResourceContractMismatch & { params: Params },
): void {
  const id = tupleId(entry.key, entry.params);
  const prev = byTuple.get(id);
  if (
    prev !== undefined &&
    prev.reason === entry.reason &&
    prev.verdict === entry.verdict
  ) {
    return;
  }
  byTuple.delete(id);
  byTuple.set(id, {
    key: entry.key,
    reason: entry.reason,
    ...(entry.verdict !== undefined ? { verdict: entry.verdict } : {}),
  });
  rebuild();
}

/** The server answered `key` at `params`: whatever refused it before no longer does. */
export function clearResourceContractMismatch(
  key: string,
  params: Params,
): void {
  if (byTuple.delete(tupleId(key, params))) rebuild();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly ResourceContractMismatch[] {
  return perKey;
}

/** Every resource the server currently refuses for this tab, one entry per key. */
export function useResourceContractMismatches(): readonly ResourceContractMismatch[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Forget every mismatch — tests only (via `web/testing`). */
export function resetResourceContractMismatches(): void {
  byTuple.clear();
  rebuild();
}
