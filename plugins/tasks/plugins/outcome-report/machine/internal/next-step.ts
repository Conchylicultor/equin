import {
  EXIT_WHEN_TEXT,
  type ExitWhen,
} from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";

/**
 * What the agent is told once its report is saved: its mandate's exit rule
 * (`exit.clean`), word for word — the same text its `## Mandate` section
 * carries, so the tool can never contradict it. A pending `question` waits for
 * its answer whatever the rule; no exit grant leaves the conversation open.
 */
export function nextStepAfterReport(
  exitWhen: ExitWhen | null,
  asked: boolean,
): string {
  if (asked)
    return "Report saved. End your turn: your question waits for the user's answer, which arrives as your next message.";
  if (exitWhen === null)
    return "Report saved. End your turn; do not close the conversation.";
  return `Report saved. ${EXIT_WHEN_TEXT[exitWhen]}`;
}
