import type { ReactElement } from "react";
import { useConfig } from "@plugins/config_v2/web";
import {
  ConversationItem,
  type ConversationItemConv,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useTaskShortTitle } from "@plugins/tasks/plugins/task-title/web";
import { useOptimisticConversationStatus } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { conversationListConfig } from "../../shared/config";
import { resolveListTitle } from "../internal/list-title";
import { useHintAnchor } from "@plugins/hints/web";
import { conversationRowAnchor } from "../../core";

/**
 * A row the list names: the item's own fields plus its task (id and current
 * title), and the `updatedAt` the shown status is reconciled against.
 */
type SidebarConv = ConversationItemConv & {
  taskId: string;
  taskTitle: string;
  updatedAt: Date;
};

/**
 * One row of the conversations list (every source's `renderRow`), named per the
 * `titleMode` setting. Only this list reads the setting — chips and every other
 * surface keep the conversation title.
 *
 * `useConfig` (not `useConfigResult`): every mode's label is a true name for the
 * row, so the defaults answer of the unreachable-after-boot pending window
 * asserts nothing about the user's data.
 *
 * `muted` dims the title for a source-specific reason (the Queue's blocked rows).
 *
 * Takes any row naming its task — the Queue's full `Conversation` and
 * History's list row alike.
 *
 * The row's status is the one the conversation header shows: `working` from the
 * instant a turn is sent (`useOptimisticConversationStatus`), so the dot and the
 * chip never disagree while the server catches up.
 */
export function SidebarConversationItem({
  conv: row,
  muted,
}: {
  conv: SidebarConv;
  muted?: boolean;
}): ReactElement {
  const { titleMode } = useConfig(conversationListConfig);
  const conv = { ...row, status: useOptimisticConversationStatus(row) };
  // The row's hint anchor (an onboarding tour points at the conversation it
  // started).
  const anchorRef = useHintAnchor(conversationRowAnchor.at(row.id));
  // Split so only the short mode subscribes to the short-title rows.
  if (titleMode === "short")
    return <ShortTitleItem conv={conv} muted={muted} anchorRef={anchorRef} />;
  return (
    <ConversationItem
      ref={anchorRef}
      conv={conv}
      layout="line"
      muted={muted}
      title={resolveListTitle(titleMode, conv, null)}
    />
  );
}

function ShortTitleItem({
  conv,
  muted,
  anchorRef,
}: {
  conv: SidebarConv;
  muted?: boolean;
  anchorRef: (el: HTMLElement | null) => void;
}): ReactElement {
  const short = useTaskShortTitle(conv.taskId);
  return (
    <ConversationItem
      ref={anchorRef}
      conv={conv}
      layout="line"
      muted={muted}
      title={resolveListTitle(
        "short",
        conv,
        short.status === "ready" && short.found ? short.row : null,
      )}
    />
  );
}
