import type { ConversationLaunchCause } from "./launch-cause";

/**
 * Was this conversation ADOPTED (`launchCause: "adopted"`): a live agent
 * session a retired runtime found running with no conversation row? Nothing
 * launched it on purpose, so the queue shows it in its own Lost section rather
 * than ranking it among the user's work. Nothing adopts any more; the rows it
 * made keep the cause.
 */
export function isAdoptedConversation(conv: {
  launchCause: ConversationLaunchCause;
}): boolean {
  return conv.launchCause === "adopted";
}
