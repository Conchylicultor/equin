import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// Single owner of the "sentinel" durable log channel. `defineLogSink` declares
// the file sink EXACTLY ONCE (a duplicate id throws), but both the onset
// re-emitter (onset.ts) and the sampler's worker-log relay (sampler.ts) write
// to it — so the declaration is hoisted here and imported by both, rather than
// declared twice.
export const sentinelLog = defineLogSink({
  id: "sentinel",
  description:
    "Sentinel onset TRIP/CLEAR + worker-supervision diagnostic prose (the durable duress signal is the duress-episodes channel).",
});
