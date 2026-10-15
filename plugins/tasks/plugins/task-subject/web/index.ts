import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useSubjectTask } from "./hooks/use-subject-task";

export default {
  description:
    "Reads back the live task about a subject — the record a task was launched about (useSubjectTask).",
  contributions: [],
} satisfies PluginDefinition;
