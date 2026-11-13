import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

/**
 * Why a conversation was launched at this moment — stored as
 * `conversations.launch_cause`, shown as every conversation list's "Launched"
 * field. Who launched it is a separate fact (`launchedFrom`, a plugin id);
 * whether a person, an agent or the system runs it is the conversation's `kind`.
 *
 * - `direct`: its launcher started it as the immediate effect of its own call
 *   (Launch, New conversation, a fork, a launch prompt, a saved agent, a triage
 *   dispatch, a summary, a transcription).
 * - `armed`: auto-start launched an armed task the moment it was armed.
 * - `unblocked`: auto-start launched an armed task when what blocked it cleared.
 * - `reconcile`: auto-start's boot reconcile launched a task a missed wake-up
 *   left armed.
 * - `adopted`: a live session the retired tmux runtime found running with no
 *   row. Never written any more; the rows it made keep it.
 *
 * Design: research/2026-11-13-conversations-typed-launch-cause.md.
 */
export const CONVERSATION_LAUNCH_CAUSES = [
  "direct",
  "armed",
  "unblocked",
  "reconcile",
  "adopted",
] as const;

export type ConversationLaunchCause =
  (typeof CONVERSATION_LAUNCH_CAUSES)[number];

/** The causes the auto-start launcher launches under (what woke it). */
export type AutoStartLaunchCause = Extract<
  ConversationLaunchCause,
  "armed" | "unblocked" | "reconcile"
>;

export const AUTO_START_LAUNCH_CAUSES = [
  "armed",
  "unblocked",
  "reconcile",
] as const satisfies readonly AutoStartLaunchCause[];

/** How each cause is named: the "Launched" field's options. */
export const CONVERSATION_LAUNCH_CAUSE_OPTIONS = {
  direct: { label: "Directly" },
  armed: { label: "When armed" },
  unblocked: { label: "When unblocked" },
  reconcile: { label: "On reconcile" },
  adopted: { label: "Adopted" },
} as const;

/**
 * Every launch states why and from which plugin. For an auto-start launch
 * `from` is the plugin that ARMED the task (the launcher is named by the cause).
 */
export interface ConversationLaunch {
  cause: ConversationLaunchCause;
  from: PluginId;
}
