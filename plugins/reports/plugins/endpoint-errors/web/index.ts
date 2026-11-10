import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { EndpointErrorReporter } from "./components/endpoint-error-reporter";

export default {
  description:
    "Files crash tasks for bug-shaped handled endpoint errors (validation 400s and 5xx).",
  contributions: [
    Core.Root({ component: EndpointErrorReporter, scope: "page" }),
  ],
} satisfies PluginDefinition;
