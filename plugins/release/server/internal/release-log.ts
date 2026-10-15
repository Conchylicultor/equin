import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { RELEASE_LOG_CHANNEL } from "../../core/targets";

// Single owner of the "release" durable log channel. `defineLogSink` declares the
// file sink exactly once (a duplicate id throws), so the channel is created here
// and shared by every release server module (run-release, preview-manager, …).
// Persisted → logs/release.jsonl, which the per-run logs endpoint reads as the
// fallback after the live stream ends.
export const releaseLog = defineLogSink({
  id: RELEASE_LOG_CHANNEL,
  description:
    "Release engine run log: stdout/stderr streamed from `./singularity release`, read back by the per-run logs endpoint.",
});
