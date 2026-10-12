import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { automationConfigContributions } from "@plugins/tasks/plugins/automations/web";
import { upstreamMergeConfig } from "../shared/config";

export default {
  description:
    "Registers the Upstream merges automation's config (schedule, push policy, model, prompt template) for the Automations pane and Settings → Config.",
  contributions: [...automationConfigContributions(upstreamMergeConfig)],
} satisfies PluginDefinition;
