import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { dropLegacyPendingTurns } from "./internal/legacy-cleanup";

export { useSendConversationTurn, useTurnSendInFlight } from "./internal/send";
export type { TurnSend } from "./internal/send";
export {
  usePendingTurns,
  useOptimisticConversationStatus,
  useTurnRunning,
} from "./internal/pending";
export type {
  PendingCard,
  PendingTurn,
  PendingTurnState,
} from "./internal/pending";
export type { TurnDelivery } from "./internal/delivery";
export { useTurnSendAvailability } from "./internal/delivery";
export { conversationPromptDraft } from "./internal/prompt-draft";
export {
  PendingTurnCard,
  type RenderEcho,
} from "./components/pending-turn-card";

export default {
  description:
    "The single entry point for sending a turn from the browser (useSendConversationTurn, bound to the subtree's transport: mints the turn's ledger id, shows its echo at once, then runs its delivery), and the view of the server's turn ledger (conversations/turn-ledger): usePendingTurns merges a conversation's live ledger rows with this tab's sends whose row has not arrived, PendingTurnCard renders each by state (echo while held or being typed, a warning when the CLI merged it with leftover text, Retry + Copy to draft when it failed), and useOptimisticConversationStatus reads a conversation as working from the instant a turn is sent. Every surface (prompt input, template chips, Send/Queue/Go, Push & Close, AskUserQuestion answers) sends through it and differs only in its delivery. Contributes the turn-send-safety lint rule.",
  register: [dropLegacyPendingTurns],
  contributions: [],
} satisfies PluginDefinition;
