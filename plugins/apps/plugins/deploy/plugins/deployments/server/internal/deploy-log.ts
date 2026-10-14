import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { DEPLOY_LOG_CHANNEL } from "../../core/runs";

/**
 * Single owner of the durable `deploy` log channel — the `releaseLog` twin.
 * Declared exactly once (a duplicate id throws), so every module that writes a
 * deploy line imports this one channel.
 *
 * Durable rather than `Log.channel`, and that is the whole reason a run needs no
 * table: the JSONL under `logs/deploy.jsonl` outlives the backend restart that
 * drops the in-memory run state, so what a converge or ship actually did is
 * still readable afterwards.
 */
export const deployLog = defineLogSink({
  id: DEPLOY_LOG_CHANNEL,
  description:
    "Deploy run log: stdout/stderr streamed from `./singularity deploy converge|ship`, surfaced live in the Deploy app's Deployments section.",
  consumer: {
    kind: "rendering-only",
    note: "`singularity deploy converge|ship` output, streamed into the Deploy app's Deployments section. A deploy progress log, not a failure funnel: a failed run's own verdict is the CLI's message, surfaced on the deployment row via the `deploy.runs` live resource — the human is watching the run they just started, so it needs no alert funnel.",
  },
});
