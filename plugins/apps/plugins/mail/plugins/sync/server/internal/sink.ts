import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// Single owner of the "mail-sync" durable log channel. `defineLogSink` declares
// the sink exactly once (a duplicate id throws), so the tick / backfill /
// attachment-scan jobs — which all log ops here — share this ONE declaration
// rather than each declaring their own. Replaces the old `Log.emit("mail-sync", …)`
// ingress-style calls, which silently persisted from arbitrary server code.
export const mailSyncLog = defineLogSink({
  id: "mail-sync",
  description:
    "Gmail sync engine ops log: bootstrap / backfill / delta / attachment-scan caps and recoveries.",
});
