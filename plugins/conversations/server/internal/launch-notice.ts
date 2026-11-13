import type {
  ConversationKind,
  ConversationLaunchCause,
} from "@plugins/tasks/plugins/tasks-core/core";

/**
 * What a new conversation's launch announces, or `null` for nothing
 * (research/2026-11-13-conversations-typed-launch-cause.md): every launch the
 * user is not already looking at is announced — the launcher showing it
 * (`shownByLauncher`: an opened pane, an embedded thread) would only cover
 * what they see — except a system conversation (triage, summaries), the app's
 * own plumbing. One launched because what blocked its task cleared says so.
 */
export function launchNotice(launch: {
  kind: ConversationKind;
  launchCause: ConversationLaunchCause;
  shownByLauncher: boolean;
}): { title: string; unblocked: boolean } | null {
  if (launch.kind === "system" || launch.shownByLauncher) return null;
  const unblocked = launch.launchCause === "unblocked";
  return {
    title: unblocked ? "Conversation unblocked" : "Conversation started",
    unblocked,
  };
}
