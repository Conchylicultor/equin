import { createContext, useContext, type ReactElement } from "react";
import {
  defineItemActions,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  DataViewSourceProps,
  ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  CONVERSATION_SEARCHABLE,
  conversationHistory,
  type ConversationListLiveRow,
} from "@plugins/conversations/plugins/all-conversations/core";
import { useConversationFieldDefs } from "@plugins/conversations/plugins/all-conversations/web";
import {
  SidebarConversationItem,
  type ConversationSidebarProps,
} from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");

// Per-consumer trailing-action slot. The close action contribution lives in this
// plugin's `web/index.ts`.
export const HistoryItemActions = defineItemActions<ConversationListLiveRow>();

/**
 * The per-render close handler cannot ride on `itemActions` props (item-action
 * components receive only `{ row, hasChildren }`), so it is threaded through this
 * module-scoped context, provided by {@link HistorySource}.
 */
const CloseConversationContext = createContext<
  ConversationSidebarProps["onCloseConversation"] | null
>(null);

/** The hover-revealed Close action contributed into {@link HistoryItemActions}. */
export function CloseConvAction({
  row,
}: ItemActionProps<ConversationListLiveRow>): ReactElement | null {
  const onCloseConversation = useContext(CloseConversationContext);
  if (!onCloseConversation) return null;
  return (
    <IconButton
      icon={closeIcon}
      label="Close conversation"
      onClick={(e) => {
        e.stopPropagation();
        return onCloseConversation(row.id, e);
      }}
    />
  );
}

/**
 * The live source: the `conversations.history` collection (every conversation,
 * system ones included — the authored "Hide system" filter preset drops them),
 * kept fresh by the routed change feed with no tick and no refetch: a status
 * flip of any conversation, a task rename and an attempt's move all reach the
 * rows a segment holds.
 */
const historySource = liveDataSource(conversationHistory, {
  searchable: CONVERSATION_SEARCHABLE,
});

/**
 * The History source of the merged conversation-sidebar DataView: the
 * {@link historySource} live origin handed to the shared surface (whose
 * `storageKey`, `conversations-sidebar`, is the collection's column scope).
 * `render(bundle)` is ALWAYS called — the rows are the source's.
 */
export function HistorySource({
  hostProps,
  render,
}: DataViewSourceProps<ConversationSidebarProps>): ReactElement {
  const { activeId, linkTo, onCloseConversation } = hostProps;
  const fields = useConversationFieldDefs();

  return (
    <CloseConversationContext.Provider value={onCloseConversation}>
      {render<ConversationListLiveRow>({
        fields,
        source: historySource,
        selectedRowId: activeId ?? undefined,
        rowActivation: (c) => linkTo(c.id),
        viewOptions: {
          list: {
            renderRow: (c: ConversationListLiveRow) => (
              <SidebarConversationItem conv={c} />
            ),
            size: "sm",
          },
        },
        itemActions: HistoryItemActions,
      })}
    </CloseConversationContext.Provider>
  );
}
