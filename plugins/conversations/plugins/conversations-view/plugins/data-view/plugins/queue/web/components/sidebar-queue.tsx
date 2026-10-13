import { type ReactElement } from "react";
import type { DataViewSourceProps } from "@plugins/primitives/plugins/data-view/web";
import { conversationsActive } from "@plugins/tasks/plugins/tasks-core/core";
import {
  SidebarConversationItem,
  type ConversationSidebarProps,
} from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import { useQueueRows, type QueueRow } from "./use-queue-rows";
import { useQueueFields } from "./queue-fields";
import {
  QueueItemActions,
  CloseConversationContext,
} from "./queue-item-actions";

/**
 * The Queue source of the merged conversation-sidebar DataView: the priority
 * queue's live data + mutation layer handed to the shared surface as a source
 * bundle. Rows carry a synthetic `section` field (default group-by) so the
 * classic status sections render as group-by sections; `manualOrder` drives the
 * neighbor-based `reorderQueue` drag; `aggregate` collapses task-groups (in the
 * ranked/working sections) to one representative + `×N` badge.
 *
 * `render(bundle)` is ALWAYS called (readiness rides in the bundle) so the
 * surface chrome never vanishes while the queue reads load or fail.
 */
export function QueueSource({
  hostProps,
  render,
}: DataViewSourceProps<ConversationSidebarProps>): ReactElement {
  const { activeId, linkTo, onCloseConversation } = hostProps;
  const { rows, dispatchReorder, readiness, paging } = useQueueRows();
  const fields = useQueueFields();

  return (
    <CloseConversationContext.Provider value={onCloseConversation}>
      {render<QueueRow>({
        rows,
        // The rows are `conversationsActive`'s (and `conversationsGone`'s,
        // which reaches the same entities): every field an extension of what
        // they reach exposes — a task's track — joins the schema, filtered
        // and grouped in memory.
        collection: conversationsActive,
        fields,
        rowKey: (c) => c.id,
        readiness,
        ...(paging ? { paging } : {}),
        selectedRowId: activeId ?? undefined,
        rowActivation: (r) => linkTo(r.id),
        viewOptions: {
          list: {
            // A blocked task's row is muted: it is waiting on another task,
            // not on the user.
            renderRow: (c: QueueRow) => (
              <SidebarConversationItem conv={c} muted={c.isBlocked} />
            ),
            size: "sm",
          },
        },
        itemActions: QueueItemActions,
        aggregate: {
          getKey: (r) =>
            r.section === "pinned" ||
            r.section === "queued" ||
            r.section === "working"
              ? r.taskId
              : null,
          pickRepresentative: (m) =>
            m.find((x) => x.status === "working" || x.status === "starting") ??
            m.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)),
        },
        manualOrder: {
          getRank: (r) => r.rank,
          onMove: (id, dest) => {
            if (!dest.targetId || !dest.zone) return;
            if (dest.targetId === id) return;
            dispatchReorder({
              conversationId: id,
              targetId: dest.targetId,
              zone: dest.zone,
            });
          },
          // No `onReseat` on purpose. `pinned` and `queued` are the two
          // draggable sections and they share one rank space, but which of the
          // two a row sits in is now the user's own pin flag, not something a
          // rank can express — so a drop into the OTHER section has no meaning a
          // reorder could carry out, and withholding `onReseat` makes the
          // primitive refuse it. Pinning is the explicit action instead. Every
          // other section has `rank: null`, so it is neither a drag source nor a
          // drop target and can never reach here.
        },
      })}
    </CloseConversationContext.Provider>
  );
}
