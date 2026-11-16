import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { capabilityCatalogServed } from "./internal/catalog";
import { mandateSection } from "./internal/instructions";

export { renderMandateInstructions } from "./internal/instructions";

export {
  Mandate,
  TaskOwnerClaim,
  claimedOwnerOf,
} from "./internal/contribution";
export type {
  MandateCapabilityEntry,
  ClaimedOwner,
  TaskOwnerClaimEntry,
} from "./internal/contribution";
export {
  conversationMandate,
  granted,
  grantOf,
  mandateOf,
} from "./internal/resolve";
export type { ConversationMandate, EffectiveMandate } from "./internal/resolve";

export default {
  description:
    "The mandate's server half: the Mandate.Capability registry (each owner contributes how its granted value reads), mandateOf (the named mandate nearest-wins up the folder tree, resolved to its definition's current policy through mandate/definitions) and grantOf (per conversation, collapsed per request burst), granted(cap) for Mcp.tool.when, the `## Mandate` system-prompt section (only the lines no tool already says), the mandate.capabilities catalog value, and TaskOwnerClaim (a plugin's claim on who owns a task — a supervisor role its backlog and session trees — read first by the tasks plugin's ownership rule through claimedOwnerOf).",
  contributions: [...capabilityCatalogServed.declare, mandateSection],
} satisfies ServerPluginDefinition;
