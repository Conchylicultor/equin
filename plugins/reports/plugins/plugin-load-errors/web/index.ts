import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { PluginLoadErrorReporter } from "./components/plugin-load-error-reporter";

export default {
  description:
    "Files crash tasks for plugins whose chunk failed to load in the deferred tier.",
  contributions: [
    Core.Root({ component: PluginLoadErrorReporter, scope: "page" }),
  ],
} satisfies PluginDefinition;
