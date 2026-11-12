import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { PluginLoadErrorReporter } from "./components/plugin-load-error-reporter";

export default {
  description:
    "Files crash tasks for plugins whose chunk failed to load, each after a load probe: the tab walks the failing plugin's static import graph through its own import map and asks the server for each file, so the report says what failed (a 404 file of its build — named as missingFile, the server re-checks it as retired — every file served, a network error, another status) instead of the browser's one ambiguous message.",
  contributions: [
    Core.Root({ component: PluginLoadErrorReporter, scope: "page" }),
  ],
} satisfies PluginDefinition;
