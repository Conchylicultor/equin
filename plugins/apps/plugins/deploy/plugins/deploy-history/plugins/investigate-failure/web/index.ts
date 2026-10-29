import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { investigateDeployFailures } from "./components/investigate-failure-action";

export default {
  description:
    "Contributes the investigate row action to every failed run in a deployment's History, launching an agent briefed on that failure — the CLI's own message verbatim, the run's identity and pinned bundle, and where the transcript is.",
  contributions: [investigateDeployFailures],
} satisfies PluginDefinition;
