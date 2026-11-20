import { defineScopedStore } from "@plugins/primitives/plugins/scope/plugins/scoped-store/web";
import {
  isTransitioning,
  type HealthStatus,
  type ReportedStatus,
  type SetRows,
} from "../../core";

/**
 * Each status row's latest status, keyed by row id — and each row set's items'
 * under `${setId}/${key}`. A row with no entry has not reported yet — which
 * the merge reads as `unknown`, never as `ok`.
 */
export type HealthStatuses = Readonly<Record<string, HealthStatus>>;

/** One item of a published row set, in the set's order (its status is in `statuses`). */
export interface SetEntry {
  key: string;
  title: string;
}

/**
 * The report's state: every published status, and every row set's items.
 *
 * A row set is in one of three shapes here:
 * - unreported: no `sets` entry and no status under its id — one pending row;
 * - pending / failed: no `sets` entry, one `unknown` status under its id;
 * - ready: its items in `sets` (possibly none), their statuses under
 *   `${setId}/${key}`, and nothing under its id.
 */
export interface HealthReportState {
  statuses: HealthStatuses;
  sets: Readonly<Record<string, readonly SetEntry[]>>;
}

/**
 * Module-level factory; the STATE is per `<HealthStore.Provider>` mount — one
 * per mounted `HealthReportButton`. The two action-bar hosts are mutually
 * exclusive, so in practice there is exactly one live store.
 */
export const HealthStore = defineScopedStore<HealthReportState>(() => ({
  statuses: {},
  sets: {},
}));

/** The status key of one item of a row set. */
export function setItemId(setId: string, key: string): string {
  return `${setId}/${key}`;
}

/**
 * What one contribution contributes to the merge, read from the state: a status
 * row its one status (`undefined` until reported); a row set each item's, or —
 * pending, failed or unreported — the one status under its id. A ready set with
 * no items contributes nothing.
 */
export function reportedStatusesOf(
  state: HealthReportState,
  row: { kind: "status" | "set"; id: string },
): ReportedStatus[] {
  if (row.kind === "set") {
    const items = state.sets[row.id];
    if (items !== undefined)
      return items.map((item) => state.statuses[setItemId(row.id, item.key)]);
  }
  return [state.statuses[row.id]];
}

/** The marks an ambient status carries, as one comparable key ("" for none). */
function marksKey(status: HealthStatus): string {
  if (status.state !== "attention" || status.ambient === undefined) return "";
  return JSON.stringify(status.ambient);
}

/** A status's summary and per-state title, as one comparable pair. */
function wordsOf(
  status: HealthStatus,
): [string | undefined, string | undefined] {
  return [status.summary, "title" in status ? status.title : undefined];
}

function sameStatus(a: HealthStatus, b: HealthStatus): boolean {
  const [aSummary, aTitle] = wordsOf(a);
  const [bSummary, bTitle] = wordsOf(b);
  return (
    a.state === b.state &&
    aSummary === bSummary &&
    aTitle === bTitle &&
    isTransitioning(a) === isTransitioning(b) &&
    marksKey(a) === marksKey(b)
  );
}

/**
 * Record one row's status. Returns the SAME state when nothing changed, so the
 * scoped store's `Object.is` bail keeps a probe that re-reports every render
 * from notifying anyone.
 */
export function withStatus(
  state: HealthReportState,
  id: string,
  status: HealthStatus,
): HealthReportState {
  const prev = state.statuses[id];
  if (prev !== undefined && sameStatus(prev, status)) return state;
  return { ...state, statuses: { ...state.statuses, [id]: status } };
}

/** Drop one row's entry (its probe unmounted). */
export function withoutStatus(
  state: HealthReportState,
  id: string,
): HealthReportState {
  if (!(id in state.statuses)) return state;
  const statuses = { ...state.statuses };
  delete statuses[id];
  return { ...state, statuses };
}

/** True for the set's own key and every item key under it. */
function isUnder(setId: string, key: string): boolean {
  return key === setId || key.startsWith(`${setId}/`);
}

/** The statuses a set's rows publish, keyed as the store keys them. */
function statusesOfSet(
  setId: string,
  rows: SetRows,
): Record<string, HealthStatus> {
  switch (rows.kind) {
    case "pending":
      return { [setId]: { state: "unknown" } };
    case "error":
      return { [setId]: { state: "unknown", summary: rows.summary } };
    case "ready":
      return Object.fromEntries(
        rows.rows.map((item) => [setItemId(setId, item.key), item.status]),
      );
  }
}

function sameEntries(
  a: readonly SetEntry[] | undefined,
  b: readonly SetEntry[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.length === b.length &&
    a.every((e, i) => e.key === b[i]?.key && e.title === b[i]?.title)
  );
}

/**
 * Replace EVERYTHING one row set has published — its own entry and every item
 * under `${setId}/` — with what `rows` says, in one write: an item that
 * vanished from the list is dropped with it, never left behind. Returns the
 * SAME state when nothing changed (see `withStatus`).
 *
 * Throws on two items sharing a key: they would share one status.
 */
export function withStatusesUnder(
  state: HealthReportState,
  setId: string,
  rows: SetRows,
): HealthReportState {
  const next = statusesOfSet(setId, rows);
  const entries =
    rows.kind === "ready"
      ? rows.rows.map(({ key, title }) => ({ key, title }))
      : undefined;
  if (entries !== undefined && Object.keys(next).length !== entries.length) {
    throw new Error(
      `health-report: row set "${setId}" lists the same key twice (${entries.map((e) => e.key).join(", ")})`,
    );
  }
  const prevKeys = Object.keys(state.statuses).filter((k) => isUnder(setId, k));
  const unchanged =
    sameEntries(state.sets[setId], entries) &&
    prevKeys.length === Object.keys(next).length &&
    prevKeys.every((k) => {
      const prev = state.statuses[k];
      const now = next[k];
      return prev !== undefined && now !== undefined && sameStatus(prev, now);
    });
  if (unchanged) return state;
  const statuses: Record<string, HealthStatus> = {};
  for (const [k, v] of Object.entries(state.statuses))
    if (!isUnder(setId, k)) statuses[k] = v;
  Object.assign(statuses, next);
  const sets = { ...state.sets };
  if (entries === undefined) delete sets[setId];
  else sets[setId] = entries;
  return { statuses, sets };
}

/** Drop everything one row set has published (its probe unmounted). */
export function withoutSet(
  state: HealthReportState,
  setId: string,
): HealthReportState {
  const hasStatus = Object.keys(state.statuses).some((k) => isUnder(setId, k));
  if (!hasStatus && !(setId in state.sets)) return state;
  const statuses: Record<string, HealthStatus> = {};
  for (const [k, v] of Object.entries(state.statuses))
    if (!isUnder(setId, k)) statuses[k] = v;
  const sets = { ...state.sets };
  delete sets[setId];
  return { statuses, sets };
}
