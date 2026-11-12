import type { ClientHour } from "@plugins/debug/plugins/latency-ledger/server";

// How many times does ONE client load (or navigate to) the same route in an
// hour? Judged per client, because a reload loop is spread thin across ops: a
// tab reloading 34×/hour adds ~280 subscriptions per 5 min in total but only
// ~34 an hour to each resource key, inside every op's own usual range
// (debug/op-rate). Its page loads, counted per tab, are not.
//
// Per ROUTE, because a loop repeats where it goes (a reload, a redirect
// ping-pong) while browsing goes somewhere new: an agent visiting 30
// different routes in an hour is exploring, not looping.
//
// The usual count is a high quantile of every client-route-hour (one tab's
// interactions of one kind to one route in one UTC clock hour, ≥ 1) over the
// 7 days before today — today excluded, so a loop that started today is never
// its own baseline. Every client counts, the automated ones too: nothing is
// left out of the history or of the judging.

/** The quantile of past client-hours that is "usual": all but 1 % of them. */
export const CLIENT_HOUR_QUANTILE = 0.99;
/** Past client-route-hours needed before a kind is judged at all (warm-up below). */
export const MIN_HISTORY_CLIENT_HOURS = 100;
export const HISTORY_DAYS = 7;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The history a tick at `nowMs` judges against: the 7 whole UTC days before
 * today. Its rows can still arrive hours late (a tab posts what it kept while
 * the server was down), so the job reads it again every hour, not once a day.
 */
export function historyRange(nowMs: number): { from: Date; to: Date } {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { from: new Date(today - HISTORY_DAYS * DAY_MS), to: new Date(today) };
}

/** The clock hour so far: what a tick at `nowMs` counts. */
export function currentHour(nowMs: number): { from: Date; to: Date } {
  return {
    from: new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS),
    to: new Date(nowMs),
  };
}

/** Nearest-rank quantile of non-empty `values`. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new Error("quantile of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

export type Kind = ClientHour["kind"];

/** One kind's history, summarised: how many client-hours, and the usual count. */
export type KindBaseline =
  | { kind: "judged"; clientHours: number; usual: number }
  | { kind: "warm-up"; clientHours: number };

export function baselineOf(
  history: readonly ClientHour[],
): Record<Kind, KindBaseline> {
  const of = (k: Kind): KindBaseline => {
    const counts = history.filter((h) => h.kind === k).map((h) => h.count);
    if (counts.length < MIN_HISTORY_CLIENT_HOURS)
      return { kind: "warm-up", clientHours: counts.length };
    return {
      kind: "judged",
      clientHours: counts.length,
      usual: quantile(counts, CLIENT_HOUR_QUANTILE),
    };
  };
  return { "page-load": of("page-load"), navigate: of("navigate") };
}

export interface ClientRateTrip {
  clientId: string;
  interaction: Kind;
  route: string;
  count: number;
  automated: boolean;
  usual: number;
  threshold: number;
  historyClientHours: number;
}

/**
 * Every (client, route) whose hour so far is past `factor` × the usual
 * client-route-hour of its kind. The hour so far only grows, so judging it against whole hours
 * never fires early. A kind still in warm-up judges nothing.
 */
export function judgeClientHours(
  current: readonly ClientHour[],
  baseline: Record<Kind, KindBaseline>,
  factor: number,
): ClientRateTrip[] {
  const trips: ClientRateTrip[] = [];
  for (const c of current) {
    const b = baseline[c.kind];
    if (b.kind !== "judged") continue;
    const threshold = factor * b.usual;
    if (c.count <= threshold) continue;
    trips.push({
      clientId: c.clientId,
      interaction: c.kind,
      route: c.route,
      count: c.count,
      automated: c.automated,
      usual: b.usual,
      threshold,
      historyClientHours: b.clientHours,
    });
  }
  return trips.sort((a, b) => b.count / b.threshold - a.count / a.threshold);
}

/** What a report is grouped by: the app the client's busiest route belongs to (`/demo/at/x` → `/demo`). */
export function appOfRoute(route: string): string {
  const seg = route.split(/[/?;#]/).find((s) => s.length > 0);
  return seg === undefined ? "/" : `/${seg}`;
}
