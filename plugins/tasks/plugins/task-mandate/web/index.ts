import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { TaskMandateControl } from "./components/mandate-control";

export default {
  description:
    "The task detail's Mandate control: the task's effective mandate (Interactive / Supervisor / an automation's) as a select; picking one states it as the task's own, governing its subtree.",
  contributions: [],
} satisfies PluginDefinition;
