import { useSyncExternalStore } from "react";
import type {
  ContractVerdict,
  SubErrorReason,
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";

// Which resources this tab's bundle no longer speaks the contract of — the
// server refused a subscription (or its HTTP read) as `contract-mismatch` or
// `unknown-key`. With a `skew` verdict that means the tab runs an older bundle
// than the server, so the app-wide Reload advice reads it (build's
// `useReloadAdvice`): one surface for every resource, instead of each read
// rendering its own permanent failure.
//
// Module-level, page-global: the transport (`NotificationsClient`) writes it
// from both the WS `sub-error` frame and a failed HTTP read's typed body, and
// nothing ever clears an entry — a tab out of date stays out of date until it
// reloads. One entry per resource key: the advice counts resources, not tuples.

export interface ResourceContractMismatch {
  key: string;
  reason: Extract<SubErrorReason, "contract-mismatch" | "unknown-key">;
  /** Absent from a server that predates verdicts — never read as `skew`. */
  verdict?: ContractVerdict;
}

// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: the one NotificationsClient per page (the single writer) learns that THIS BUNDLE no longer speaks a resource's contract — a fact about the page's code, identical for every keep-alive/desktop surface mount, exactly like the sibling deferred-load store the same Reload advice reads. A per-surface store would be semantically wrong.
let mismatches: readonly ResourceContractMismatch[] = [];
const listeners = new Set<() => void>();

/** Record that the server refused `key` for this tab. Idempotent per identical entry. */
export function markResourceContractMismatch(
  entry: ResourceContractMismatch,
): void {
  const prev = mismatches.find((m) => m.key === entry.key);
  if (
    prev !== undefined &&
    prev.reason === entry.reason &&
    prev.verdict === entry.verdict
  ) {
    return;
  }
  mismatches = [...mismatches.filter((m) => m.key !== entry.key), entry];
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly ResourceContractMismatch[] {
  return mismatches;
}

/** Every resource the server refused for this tab, one entry per key. */
export function useResourceContractMismatches(): readonly ResourceContractMismatch[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Forget every mismatch — tests only (via `web/testing`). */
export function resetResourceContractMismatches(): void {
  mismatches = [];
  for (const l of listeners) l();
}
