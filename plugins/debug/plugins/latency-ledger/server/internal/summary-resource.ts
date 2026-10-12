import { serveValue } from "@plugins/network/plugins/live/server";
import { latencySummary, type LatencyWindow } from "../../core";
import { createFlushNotifier } from "./flush-notifier";
import { loadLatencySummary } from "./query";

// The summary's tables are excluded from the change feed by declaration
// (./contributions): written every minute, they must not drive a recompute per
// write. That makes the feed blind to them, so the value is served external and
// its change source is the ledger's own minute flush — the one writer that
// knows a minute landed. (The browser's batches merge into the same rows at any
// time; the next flush carries them.) The no-db-backed-notify check sanctions
// this from the plugin's ExcludeFromChangeFeed contributions.

const flushNotifier = createFlushNotifier<LatencyWindow>();

export const latencySummaryServed = serveValue(latencySummary, {
  source: "external",
  changes: "notified",
  loader: ({ window }) => loadLatencySummary(window),
  whileSubscribed: ({ window }, notify) =>
    flushNotifier.subscribe(window, notify),
});

/** A minute was written: refresh every subscribed window, once per minute. */
export function noteFlushedMinute(minuteStart: number): void {
  flushNotifier.flushed(minuteStart);
}
