import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
// Side-effect registration only: see ./internal/register.
import "./internal/register";

export default {
  description:
    "Workspace web presence: eagerly registers the boot-preloaded workspace.catalog live value (every workspace a task can name) so boot-snapshot can hydrate it before first paint.",
  contributions: [],
} satisfies PluginDefinition;
