import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { capabilityCatalogServed } from "./internal/catalog";
import { mandateInstructions } from "./internal/instructions";

export { Mandate } from "./internal/contribution";
export type { MandateCapabilityEntry } from "./internal/contribution";
export { granted, grantOf, mandateOf } from "./internal/resolve";
export type { EffectiveMandate } from "./internal/resolve";

export default {
  description:
    "The mandate's server half: the Mandate.Capability registry (each owner contributes how its granted value reads), mandateOf (nearest-wins up the folder tree) and grantOf (per conversation, collapsed per request burst), granted(cap) for Mcp.tool.when, the `## Mandate` MCP instructions section, and the mandate.capabilities catalog value.",
  contributions: [...capabilityCatalogServed.declare],
  register: [mandateInstructions],
} satisfies ServerPluginDefinition;
