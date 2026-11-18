import { createInflight } from "@plugins/packages/plugins/inflight/core";
import type { GatewayDrift } from "../../core";
import { checkGatewayDrift } from "./check";

/**
 * How long an answer is reused by a fresh read. A main push re-checks at once
 * (the ref reaction) and `start --force` restarts every backend, so this only
 * bounds what nothing announces: a signing identity reset, a hand edit.
 */
const MAX_AGE_MS = 10 * 60_000;

let last: { drift: GatewayDrift; at: number } | null = null;
/**
 * One check at a time. Through `createInflight`, not a hand-held promise: a
 * caller that joins a check another caller started (the ref reaction's, a
 * launch's, another tab's read) waits on work it is not doing, so it gives
 * back its read-admit slot for the wait. A plain `await` of a shared promise
 * keeps the slot for the whole check (process spawns, ~1–8 s on a busy host).
 */
const checks = createInflight("gateway-drift");
const changedListeners = new Set<() => void>();

/** The last answer when fresh enough, else a new check. */
export function currentGatewayDrift(): Promise<GatewayDrift> {
  if (last !== null && Date.now() - last.at < MAX_AGE_MS)
    return Promise.resolve(last.drift);
  return recheckGatewayDrift();
}

/** Check again now (single-flight); listeners hear it when the answer moved. */
export function recheckGatewayDrift(): Promise<GatewayDrift> {
  return checks.run("check", async () => {
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
  });
}

/** Run `fn` whenever a check's answer differs from the last. Returns the unsubscribe. */
export function onGatewayDriftChanged(fn: () => void): () => void {
  changedListeners.add(fn);
  return () => {
    changedListeners.delete(fn);
  };
}
