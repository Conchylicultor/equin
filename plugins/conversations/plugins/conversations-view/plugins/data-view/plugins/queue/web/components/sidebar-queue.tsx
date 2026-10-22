import { useCallback, useMemo, type ReactElement } from "react";
import type {
  DataViewAggregateConfig,
  DataViewSourceProps,
  ManualOrderConfig,
} from "@plugins/primitives/plugins/data-view/web";
import { conversationsActive } from "@plugins/tasks/plugins/tasks-core/core";
import {
  SidebarConversationItem,
  type ConversationSidebarProps,
} from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import { useQueueRows, type QueueRow } from "./use-queue-rows";
import { QUEUE_EXTRA_FIELDS, QUEUE_OVERRIDES } from "./queue-fields";
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
  view,
  render,
}: DataViewSourceProps<ConversationSidebarProps>): ReactElement {
  const { activeId, linkTo, onCloseConversation } = hostProps;
  const { rows, dispatchReorder, readiness, paging } = useQueueRows(view);
  // Every accessor below keeps its identity across renders (module constants,
  // or memoized on what they close over): the list view memoizes each row on
  // them, so a fresh closure here would re-render every row of the queue.
  const rowActivation = useCallback((r: QueueRow) => linkTo(r.id), [linkTo]);
  const manualOrder = useMemo(
    (): ManualOrderConfig<QueueRow> => ({
      getRank: queueRank,
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
    }),
    [dispatchReorder],
  );

  return (
    <CloseConversationContext.Provider value={onCloseConversation}>
      {render<QueueRow>({
        rows,
        // The rows are `conversationsActive`'s (and `conversationsGone`'s,
        // declared with the same fields and reach): the schema is derived
        // from it — the conversation's fields and every field an extension of
        // what it reaches exposes (a task's track) — filtered and grouped in
        // memory. The Queue adds only its `section`.
        collection: conversationsActive,
        overrides: QUEUE_OVERRIDES,
        extraFields: QUEUE_EXTRA_FIELDS,
        rowKey: queueRowKey,
        readiness,
        ...(paging ? { paging } : {}),
        selectedRowId: activeId ?? undefined,
        rowActivation,
        viewOptions: QUEUE_VIEW_OPTIONS,
        itemActions: QueueItemActions,
        aggregate: QUEUE_AGGREGATE,
        manualOrder,
      })}
    </CloseConversationContext.Provider>
  );
}

const queueRowKey = (c: QueueRow): string => c.id;

const queueRank = (r: QueueRow) => r.rank;

const QUEUE_VIEW_OPTIONS = {
  list: {
    // A blocked task's row is muted: it is waiting on another task, not on
    // the user.
    renderRow: (c: QueueRow) => (
      <SidebarConversationItem conv={c} muted={c.isBlocked} />
    ),
    size: "sm",
  },
};

/** Task-groups collapse to one representative in the ranked/working sections. */
const QUEUE_AGGREGATE: DataViewAggregateConfig<QueueRow> = {
  getKey: (r) =>
    r.section === "pinned" || r.section === "queued" || r.section === "working"
      ? r.taskId
      : null,
  pickRepresentative: (m) =>
    m.find((x) => x.status === "working" || x.status === "starting") ??
    m.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)),
};
