import { serveValue } from "@plugins/network/plugins/live/server";
import { latencySummary, type LatencyWindow } from "../../core";
import { createFlushNotifier } from "./flush-notifier";
import { loadLatencySummary } from "./query";
import {
  _latencyLedgerHostMinute,
  _latencyLedgerInteraction,
  _latencyLedgerMinute,
  _latencyLedgerThreadMinute,
} from "./tables";

// The summary's tables are excluded from the change feed by declaration
// (./contributions): written every minute, they must not drive a recompute per
// write. That makes the feed blind to them, so the value is served external and
// its change source is the ledger's own minute flush — the one writer that
// knows a minute landed. (The browser's batches merge into the same rows at any
// time; the next flush carries them.) It declares those reads as `outsideFeed`:
// accepted by the read-set drift guard, never routed.

const flushNotifier = createFlushNotifier<LatencyWindow>();

export const latencySummaryServed = serveValue(latencySummary, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [],
    reason:
      "the summary reads only the latency ledger's own tables, which the change feed skips",
    outsideFeed: {
      tables: [
        _latencyLedgerMinute,
        _latencyLedgerHostMinute,
        _latencyLedgerThreadMinute,
        _latencyLedgerInteraction,
      ],
      reason:
        "written by the ledger's minute flush and the browser's batches, and excluded from the change feed so a write does not recompute per row; the minute flush notifies every subscribed window instead, since a landed minute may change any window's percentiles",
    },
  },
  loader: ({ window }) => loadLatencySummary(window),
  whileSubscribed: ({ window }, notify) =>
    flushNotifier.subscribe(window, notify),
});

/** A minute was written: refresh every subscribed window, once per minute. */
export function noteFlushedMinute(minuteStart: number): void {
  flushNotifier.flushed(minuteStart);
}
