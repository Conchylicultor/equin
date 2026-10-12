import { defineAutomationConfig } from "@plugins/tasks/plugins/automations/core";
import { UPSTREAM_MERGE_PROMPT } from "./merge-prompt";

/** The Upstream merges automation's id — its job is `automation.upstream-merge`. */
export const UPSTREAM_MERGE_ID = "upstream-merge";

/**
 * The Upstream merges automation's config: off until the user turns it on;
 * then daily at 07:00 local, never pushing — the agent merges upstream into its own worktree, builds, and
 * raises a flag for the user to land it. On a checkout with no upstream (the
 * canonical repo) every run finds nothing. Stored as
 * `config/tasks/automations/upstream-merge.origin.jsonc`.
 */
export const upstreamMergeConfig = defineAutomationConfig(UPSTREAM_MERGE_ID, {
  enabled: false,
  push: "never",
  trigger: "schedule",
  cadence: "day",
  at: "07:00",
  prompt: UPSTREAM_MERGE_PROMPT,
});
