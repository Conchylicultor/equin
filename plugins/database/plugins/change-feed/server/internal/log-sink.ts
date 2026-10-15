import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// Single owner of the "change-feed" durable log channel. `defineLogSink` declares
// the file sink EXACTLY ONCE (a duplicate id throws), but both the trigger
// installer and the LISTEN consumer write to it — so the declaration is hoisted
// here and imported by both, rather than declared twice.
export const changeFeedLog = defineLogSink({
  id: "change-feed",
  description:
    "DB change-feed ops log: STATEMENT-trigger install and the LISTEN consumer's recompute cascade.",
});
