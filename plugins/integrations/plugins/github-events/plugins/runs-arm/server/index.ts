import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { githubRunKind } from "./internal/arm";

export default {
  description:
    "The GitHub arm of the merged run space: binds `github_runs` (every watched workflow's run attempts — the release publish included) into the runs union, its outcome from GitHub's status and conclusion, its label the workflow and the ref it ran on, its message the failed jobs.",
  register: [githubRunKind],
} satisfies ServerPluginDefinition;
