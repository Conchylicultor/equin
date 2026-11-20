import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export default {
  description:
    "Umbrella for CSS token group plugins: each declares its variables and schema defaults and registers them, its customizer section a `customizer` child of its own so painting never depends on the editor loading.",
  contributions: [],
} satisfies PluginDefinition;
