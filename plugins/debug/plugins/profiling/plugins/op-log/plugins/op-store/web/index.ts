import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
// Side-effect registration only: eagerly registers the boot-critical
// op-store.in-flight.all collection (see ./internal/register). The store has no UI
// of its own — the op-status banner and the Ops Gantt are its consumers.
import "./internal/register";

export default {
  description:
    "Op-store web presence: eagerly registers the boot-critical op-store.in-flight.all live collection so boot-snapshot can hydrate it before first paint.",
  contributions: [],
} satisfies PluginDefinition;
