import { serveValue } from "@plugins/network/plugins/live/server";
import {
  latencySummary,
  type LatencySummaryTabs,
  type LatencyWindow,
} from "../../core";
import { createFlushNotifier } from "./flush-notifier";
import { loadLatencySummary } from "./query";
import {
  _latencyLedgerClientMinute,
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

// One subscription per (window, tabs) tuple: each has its own notify.
const flushNotifier =
  createFlushNotifier<`${LatencyWindow}:${LatencySummaryTabs}`>();

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
        _latencyLedgerClientMinute,
        _latencyLedgerHostMinute,
        _latencyLedgerThreadMinute,
        _latencyLedgerInteraction,
      ],
      reason:
        "written by the ledger's minute flush and the browser's batches, and excluded from the change feed so a write does not recompute per row; the minute flush notifies every subscribed (window, tabs) tuple instead, since a landed minute may change any of their percentiles",
    },
  },
  loader: ({ window, tabs }) => loadLatencySummary(window, tabs),
  whileSubscribed: ({ window, tabs }, notify) =>
    flushNotifier.subscribe(`${window}:${tabs}`, notify),
});

/** A minute was written: refresh every subscribed window, once per minute. */
export function noteFlushedMinute(minuteStart: number): void {
  flushNotifier.flushed(minuteStart);
}
