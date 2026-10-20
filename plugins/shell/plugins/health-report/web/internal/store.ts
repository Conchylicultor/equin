import { defineScopedStore } from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";
import { isTransitioning, type HealthStatus } from "../../core";

/**
 * Each status row's latest status, keyed by row id. A row with no entry has not
 * reported yet — which the merge reads as `unknown`, never as `ok`.
 */
export type HealthStatuses = Readonly<Record<string, HealthStatus>>;

/**
 * Module-level factory; the STATE is per `<HealthStore.Provider>` mount — one
 * per mounted `HealthReportButton`. The two action-bar hosts are mutually
 * exclusive, so in practice there is exactly one live store.
 */
export const HealthStore = defineScopedStore<HealthStatuses>(() => ({}));

function sameStatus(a: HealthStatus, b: HealthStatus): boolean {
  return (
    a.state === b.state &&
    a.summary === b.summary &&
    isTransitioning(a) === isTransitioning(b)
  );
}

/**
 * Record one row's status. Returns the SAME state when nothing changed, so the
 * scoped store's `Object.is` bail keeps a probe that re-reports every render
 * from notifying anyone.
 */
export function withStatus(
  state: HealthStatuses,
  id: string,
  status: HealthStatus,
): HealthStatuses {
  const prev = state[id];
  if (prev !== undefined && sameStatus(prev, status)) return state;
  return { ...state, [id]: status };
}

/** Drop one row's entry (its probe unmounted). */
export function withoutStatus(
  state: HealthStatuses,
  id: string,
): HealthStatuses {
  if (!(id in state)) return state;
  const next = { ...state };
  delete next[id];
  return next;
}
