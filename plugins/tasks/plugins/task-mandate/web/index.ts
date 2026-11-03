import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { TaskMandateControl } from "./components/mandate-control";

export default {
  description:
    "The task detail's Mandate control: the task's effective mandate (Interactive / Supervisor / an automation's) as a select, an inherited one marked so and linked to the ancestor it comes from; picking a mandate states it as the task's own (governing its subtree), Inherit from parent drops it again.",
  contributions: [],
} satisfies PluginDefinition;
