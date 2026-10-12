import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";

export type TaskNotificationEvent = Extract<
  JsonlEvent,
  { kind: "task-notification" }
>;

/** Where a notification leads: the button the row draws for it. */
export interface TaskNotificationTarget {
  /** The button's label (sentence case), e.g. "View sub-agent". */
  label: string;
  icon: IconRef;
  /** What the button does — a pane's `LinkTarget`, so ⌘/middle-click opens it in a browser tab. */
  activation: Activation;
}

/**
 * A contributor's answer to "is this notification about one of yours?".
 *
 * `pending` is its own arm: a contributor that cannot answer yet holds the
 * row's button back rather than letting a later contributor claim what may
 * well be its own — the wrong pane is worse than a button that arrives late.
 */
export type TaskNotificationClaim =
  | { kind: "pending" }
  | { kind: "declined" }
  | { kind: "claimed"; target: TaskNotificationTarget };

export interface TaskNotificationOpenContribution {
  /** Names the contributor (what kind of background task it opens). */
  id: string;
  /**
   * Claim the notification when it is about a task this contributor owns.
   * A hook: owning is usually a join against a live read (the conversation's
   * sub-agents, its background shells).
   */
  useClaim: Hook<
    (
      event: TaskNotificationEvent,
      conversationId: string | null,
    ) => TaskNotificationClaim
  >;
}

export const TaskNotification = {
  /**
   * What a `<task-notification>` row opens. A notification ends SOME
   * background task — a sub-agent, a background shell, … — and only the plugin
   * that owns that kind of task knows its pane. The row asks each contribution
   * in turn and draws the first claim's button, or none when nobody claims it.
   */
  Open: defineSlot<TaskNotificationOpenContribution>({
    docLabel: (p) => p.id,
  }),
};
