import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
// Side-effect registration only (see ./internal/register).
import "./internal/register";

export default {
  description:
    "The named-mandate registry's web presence: eagerly registers the boot-preloaded mandate.definitions live value (every named mandate's id, label and the mandates it is a kind of) so boot-snapshot hydrates it before first paint.",
  contributions: [],
} satisfies PluginDefinition;
