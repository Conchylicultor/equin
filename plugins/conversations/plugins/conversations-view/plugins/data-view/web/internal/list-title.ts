import {
  conversationTitle,
  type ConversationItemConv,
  type ConvTitleOverride,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";

/**
 * The task's short title as its row carries it (the exposed short-title
 * fields): both NULL when none was generated for the task.
 */
export type ShortTitleRow = {
  shortTitle: string | null;
  sourceTitle: string | null;
};

/**
 * What a conversation-list row is named by, per the `titleMode` setting —
 * except a conversation the user named by hand (`titleByUser`,
 * conversations/rename), which is named by that title in every mode: a name
 * the user chose is never replaced by its task's.
 *
 * `short` takes the short title only while it was made from the task's CURRENT
 * title (`sourceTitle === conv.taskTitle`): a stale one — the task was renamed
 * and its short title is not regenerated yet — never reaches the screen. A task
 * with no current short title (never generated, generation refused, renamed
 * since) shows its full title. The short title arrives WITH the row (an
 * exposed field), so there is no not-known-yet state: what a row first shows
 * is its name until the data changes.
 */
export function resolveListTitle(
  mode: string,
  conv: ConversationItemConv & { taskTitle: string; titleByUser: boolean },
  short: ShortTitleRow,
): ConvTitleOverride {
  if (conv.titleByUser) {
    const title = conversationTitle(conv);
    return { label: title, full: title };
  }
  switch (mode) {
    case "conversation": {
      const title = conversationTitle(conv);
      return { label: title, full: title };
    }
    case "task":
      return { label: conv.taskTitle, full: conv.taskTitle };
    case "short":
      return {
        label:
          short.shortTitle !== null && short.sourceTitle === conv.taskTitle
            ? short.shortTitle
            : conv.taskTitle,
        full: conv.taskTitle,
      };
    default:
      // The config schema only admits the three values above.
      throw new Error(`Unknown conversation list titleMode: ${mode}`);
  }
}
