import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { BuildDetailSlots } from "@plugins/build/web";
import { BuildLogSection } from "./components/build-log-section";

export default {
  description:
    "Logs section in the build detail pane: the run's persisted steps and lines (build.run-logs, newest first, paged by viewport), else the live log channel.",
  contributions: [
    BuildDetailSlots.Section({ id: "logs", label: "Logs", component: BuildLogSection }),
  ],
} satisfies PluginDefinition;
