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
 * Whether the agent is busy without the user: starting, running a turn, or
 * idle between turns with background work pending (it wakes when that work
 * lands). The opposite — at rest — is when its work is in front of the user:
 * the moment to try what it built or decide what happens next. Wider than
 * `isTurnRunning`, which is only what Stop interrupts.
 */
export function isAgentBusy(status: ConversationStatus): boolean {
  return status === "starting" || status === "working";
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
