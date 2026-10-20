import type {
  ConversationStatus,
  ConversationWorkingOn,
} from "@plugins/tasks/plugins/tasks-core/core";

export function isActiveStatus(status: ConversationStatus): boolean {
  return status !== "done";
}

export function hasLiveProcess(status: ConversationStatus): boolean {
  return status === "starting" || status === "working" || status === "waiting";
}

/**
 * Whether a turn is running — what Stop interrupts and a sent message queues
 * behind. Narrower than `working`, which also covers an agent idle between
 * turns with background work still pending (`workingOn: "background"`).
 */
export function isTurnRunning(conversation: {
  status: ConversationStatus;
  workingOn: ConversationWorkingOn | null;
}): boolean {
  return conversation.status === "working" && conversation.workingOn === "turn";
}
