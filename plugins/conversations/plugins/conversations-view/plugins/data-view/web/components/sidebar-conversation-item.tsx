import { rowOrStale } from "@plugins/network/plugins/live/web";
import type { ReactElement } from "react";
import { useConfig } from "@plugins/config_v2/web";
import {
  ConversationItem,
  ConvStatusDot,
  type ConversationItemConv,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useTaskShortTitle } from "@plugins/tasks/plugins/task-title/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
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
  dot,
}: {
  conv: SidebarConv;
  muted?: boolean;
  /** `false`: the host draws the dot as the row's lead ({@link SidebarConversationDot}). */
  dot?: boolean;
}): ReactElement {
  const { titleMode } = useConfig(conversationListConfig);
  const conv = { ...row, status: useOptimisticConversationStatus(row) };
  // The row's hint anchor (an onboarding tour points at the conversation it
  // started).
  const anchorRef = useHintAnchor(conversationRowAnchor.at(row.id));
  // Split so only the short mode subscribes to the short-title rows.
  if (titleMode === "short")
    return (
      <ShortTitleItem
        conv={conv}
        muted={muted}
        dot={dot}
        anchorRef={anchorRef}
      />
    );
  return (
    <ConversationItem
      ref={anchorRef}
      conv={conv}
      layout="line"
      muted={muted}
      dot={dot}
      title={resolveListTitle(titleMode, conv, null)}
    />
  );
}

/**
 * A row's status dot drawn apart from its {@link SidebarConversationItem}
 * (`dot={false}`) — the list's leading glyph, which a list wraps in its
 * expand/collapse disclosure (the Queue's supervisors). The same optimistic
 * status the item paints, so the two never disagree.
 *
 * Its box is the tree disclosure's (`size-5`, the merged variant's icon box),
 * so a row's title starts at the same x whether or not its list draws a
 * disclosure around the dot — and there, box plus the row's glyph gap lands
 * the title on the sidebar nav labels' column, as the item's own dot did.
 */
export function SidebarConversationDot({
  conv: row,
}: {
  conv: SidebarConv;
}): ReactElement {
  const conv = { ...row, status: useOptimisticConversationStatus(row) };
  return (
    <Center className={cn("size-5", rigidClass())}>
      {/* `md`: the dot's own density tier, whatever the list's. */}
      <ControlSizeProvider size="md">
        <ConvStatusDot conv={conv} />
      </ControlSizeProvider>
    </Center>
  );
}

function ShortTitleItem({
  conv,
  muted,
  dot,
  anchorRef,
}: {
  conv: SidebarConv;
  muted?: boolean;
  dot?: boolean;
  anchorRef: (el: HTMLElement | null) => void;
}): ReactElement {
  const short = useTaskShortTitle(conv.taskId);
  return (
    <ConversationItem
      ref={anchorRef}
      conv={conv}
      layout="line"
      muted={muted}
      dot={dot}
      title={resolveListTitle("short", conv, rowOrStale(short) ?? null)}
    />
  );
}
