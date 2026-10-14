import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// Single owner of the "live-state-snapshot" durable log channel. `defineLogSink`
// declares the file sink EXACTLY ONCE (a duplicate id throws), but both the boot
// init and the changelog catch-up write to it — so the declaration is hoisted
// here and imported by both, rather than declared twice.
export const snapshotLog = defineLogSink({
  id: "live-state-snapshot",
  description:
    "Live-state snapshot ops log: durable snapshot init and the bounded changelog catch-up on boot.",
  consumer: {
    kind: "internal",
    note: "Live-state snapshot boot-init + changelog catch-up diagnostics (database/live-state-snapshot).",
  },
});
