import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { MutationErrorWatcher } from "./components/mutation-error-watcher";

export default {
  description:
    "Warning toast and persistent notification for unhandled TanStack Query mutation errors.",
  contributions: [
    Core.Root({ component: MutationErrorWatcher, scope: "page" }),
  ],
} satisfies PluginDefinition;
