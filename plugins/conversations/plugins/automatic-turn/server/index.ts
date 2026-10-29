import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { PendingTurn } from "./internal/registry";
export type { PendingTurnEntry } from "./internal/registry";
export { automaticTurnReadiness } from "./internal/readiness";
export type { HeldTurn, TurnReadiness } from "./internal/readiness";

export default {
  portable: true,
  description:
    "Whether the app may type an automatic turn into a conversation now: automaticTurnReadiness(conversationId, { own? }) — held while the agent is busy, waits on the user (waitingFor), or another plugin's PendingTurn contribution says a turn of its own goes first; ready otherwise. Every automatic sender asks it, so two senders woken by the same status change cannot type into each other's turn. Names no sender.",
} satisfies ServerPluginDefinition;
