import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// Single owner of the "events-refresh" durable log channel.
//
// The run ledger is the primary record and covers every run that actually
// happened. This channel covers what the ledger structurally cannot: the
// non-runs — a queued job whose source was deleted or disabled meanwhile — which
// have no source row left to attach to, and the tick's own accounting.
export const refreshLog = defineLogSink({
  id: "events-refresh",
  description:
    "Events refresh engine: cadence-tick accounting plus the non-runs (source deleted or disabled between enqueue and dispatch) that leave no run-ledger row.",
});
