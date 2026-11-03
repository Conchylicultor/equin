import {
  recordSpan,
  type SpanMeasures,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { RoutedChange } from "./route-change";

// Route one change and record it as a `route` span labelled by the changed
// table, so Debug → Slow Ops and get_runtime_profile can see the routing step
// between the change (Postgres's NOTIFY, or an in-process producer's flush) and
// the runtime's recompute.
//
// The duration is the synchronous routing work only (`routeTableChange`). `sinceChangeMs` — the time from
// the trigger firing to routing done — is a measure, not the duration: it also
// counts how long the writing transaction stayed open after the statement,
// which is not routing's cost.
//
// A leaf span, not an entry: routing is synchronous and opens no child spans,
// and staying synchronous keeps a throwing route a thrown exception rather than
// a rejected promise.
export function routeWithSpan<C extends RoutedChange>(
  change: C,
  route: (change: C) => void,
): void {
  const t0 = performance.now();
  route(change);
  const routeMs = performance.now() - t0;
  const measures: SpanMeasures = {};
  if (change.ids) measures.ids = change.ids.length;
  if (change.changedAt !== undefined)
    measures.sinceChangeMs = Math.max(0, Date.now() - change.changedAt);
  recordSpan("route", change.table, routeMs, { measures });
}
