import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { depsSweepJob } from "./internal/sweep-job";

// A sub-plugin of its own because listing the checkouts is git worktree
// knowledge (infra/worktree, an agent-runtime taproot): the engine stays free
// of it, so a standalone app that runs a dependency (Sonata, via
// audio-analysis) does not pull the agent runtime in.

export default {
  description:
    "The daily deps.sweep job: removes installed optional-dependency identities that no checkout in use declares (main's, and the agent checkouts whose attempt is retained) and that sat unused for 14 days (sweepUnusedDeps over the git worktree list).",
  register: [depsSweepJob],
} satisfies ServerPluginDefinition;
