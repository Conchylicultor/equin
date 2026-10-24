import type { GatewayDrift } from "../../core";
import { checkGatewayDrift } from "./check";

/**
 * How long an answer is reused by a fresh read. A main push re-checks at once
 * (the ref reaction) and `start --force` restarts every backend, so this only
 * bounds what nothing announces: a signing identity reset, a hand edit.
 */
const MAX_AGE_MS = 10 * 60_000;

let last: { drift: GatewayDrift; at: number } | null = null;
let inflight: Promise<GatewayDrift> | null = null;
const changedListeners = new Set<() => void>();

/** The last answer when fresh enough, else a new check. */
export function currentGatewayDrift(): Promise<GatewayDrift> {
  if (last !== null && Date.now() - last.at < MAX_AGE_MS)
    return Promise.resolve(last.drift);
  return recheckGatewayDrift();
}

/** Check again now (single-flight); listeners hear it when the answer moved. */
export function recheckGatewayDrift(): Promise<GatewayDrift> {
  inflight ??= (async () => {
    try {
      const drift = await checkGatewayDrift().catch(
        (err: unknown): GatewayDrift => ({
          kind: "unreadable",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      const before = last?.drift;
      last = { drift, at: Date.now() };
      if (
        before !== undefined &&
        JSON.stringify(before) !== JSON.stringify(drift)
      )
        for (const fn of changedListeners) fn();
      return drift;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Run `fn` whenever a check's answer differs from the last. Returns the unsubscribe. */
export function onGatewayDriftChanged(fn: () => void): () => void {
  changedListeners.add(fn);
  return () => {
    changedListeners.delete(fn);
  };
}
