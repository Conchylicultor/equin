import { useCallback, useMemo, type ReactElement } from "react";
import type {
  DataViewAggregateConfig,
  DataViewSourceProps,
  ManualOrderConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type { GroupEditConfig } from "@plugins/primitives/plugins/data-view/core";
import { conversationsActive } from "@plugins/tasks/plugins/tasks-core/core";
import {
  SidebarConversationDot,
  SidebarConversationItem,
  type ConversationSidebarProps,
} from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import { useQueueRows, type QueueRow } from "./use-queue-rows";
import { QUEUE_OVERRIDES } from "./queue-fields";
import {
  filedSectionOf,
  isUserSection,
  queueSectionField,
  takesFiledRows,
} from "./queue-sections";
import {
  NEW_SECTION_NAME,
  QueueSectionsContext,
  useQueueSectionControls,
} from "./queue-section-controls";
import { queueHeaderActions } from "./queue-section-header";
import { QUEUE_ATTACH } from "./queue-attach";
import {
  QueueItemActions,
  CloseConversationContext,
} from "./queue-item-actions";

/**
 * The Queue source of the merged conversation-sidebar DataView: the priority
 * queue's live data + mutation layer handed to the shared surface as a source
 * bundle. Rows carry a synthetic `section` field (default group-by) so the
 * classic status sections render as group-by sections — Pinned, the user's own
 * sections, Queue, Working, …; `manualOrder` drives the neighbor-based
 * `reorderQueue` drag, within a section and across the filed ones (Pinned, a
 * user section, Queue), plus the "New section" drop; `groupEdit` /
 * `headerActions` rename, reorder, add and delete the user's sections; `aggregate` collapses task-groups (in the
 * ranked/working sections) to one representative + `×N` badge; `attach` draws
 * a supervised task beneath its supervisor's row (`QUEUE_ATTACH`).
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
  const { rows, sections, dispatchReorder, readiness, paging } =
    useQueueRows(view);
  const controls = useQueueSectionControls(sections);
  // The section field's options follow the user's sections (memoized on them:
  // `useQueueRows` keeps their identity while none changed).
  const extraFields = useMemo(() => [queueSectionField(sections)], [sections]);
  const { file: fileSection, create: createSection } = controls;
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
        // The write's promise: the list holds the row where it was dropped
        // until the ranks read moves it (the server mints the rank).
        return dispatchReorder({
          conversationId: id,
          targetId: dest.targetId,
          zone: dest.zone,
        });
      },
      // A drop into another filed section (Pinned, a user section, Queue):
      // the group is filed there — beside its drop neighbour (one global rank
      // space, so `reorder` places it among that section's rows), or, dropped
      // on the section itself, keeping its rank. Only the filed sections take
      // a row (`reseatInto`); every other one is read-time (Working, Done, …)
      // and has `rank: null`, so it is neither a drag source nor a target.
      reseatInto: takesFiledRows,
      onReseat: (id, dest) => {
        const section = filedSectionOf(dest.groupKey);
        if (section === undefined)
          throw new Error(
            `Queue: a row dropped into section ${String(dest.groupKey)}, which nothing is filed into.`,
          );
        if (dest.targetId === undefined || dest.zone === undefined)
          return fileSection(id, section);
        return dispatchReorder({
          conversationId: id,
          targetId: dest.targetId,
          zone: dest.zone,
          section,
        });
      },
      onReseatNew: {
        label: NEW_SECTION_NAME,
        onDrop: (id) => createSection({ conversationId: id }),
      },
    }),
    [dispatchReorder, fileSection, createSection],
  );
  const groupEdit = useMemo(
    (): GroupEditConfig => ({
      editable: isUserSection,
      onRename: (key, name) => {
        if (!isUserSection(key)) throw new Error(`Queue: rename of ${key}.`);
        return controls.rename(key, name);
      },
      onMove: (key, { targetKey, zone }) => {
        if (!isUserSection(key) || !isUserSection(targetKey))
          throw new Error(`Queue: section move ${key} → ${targetKey}.`);
        return controls.move(key, { targetId: targetKey, zone });
      },
      renaming: controls.renaming,
      setRenaming: controls.setRenaming,
    }),
    [controls],
  );
  const headerActions = useMemo(() => queueHeaderActions(controls), [controls]);

  return (
    <QueueSectionsContext.Provider value={controls}>
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
          extraFields,
        rowKey: queueRowKey,
        readiness,
        ...(paging ? { paging } : {}),
        selectedRowId: activeId ?? undefined,
        rowActivation,
        viewOptions: QUEUE_VIEW_OPTIONS,
        itemActions: QueueItemActions,
        aggregate: QUEUE_AGGREGATE,
        // Supervised tasks beneath their supervisor's row (Sub-items).
        attach: QUEUE_ATTACH,
        manualOrder,
          groupEdit,
          headerActions,
      })}
    </CloseConversationContext.Provider>
    </QueueSectionsContext.Provider>
  );
}

const queueRowKey = (c: QueueRow): string => c.id;

const queueRank = (r: QueueRow) => r.rank;

const QUEUE_VIEW_OPTIONS = {
  list: {
    // Kept: the row is the shared ConversationItem (optimistic status, title
    // mode, hint anchor, close control) — not values of fields.
    // A blocked task's row is muted: it is waiting on another task, not on
    // the user.
    // The status dot is the list's leading glyph rather than the item's, so
    // a supervisor's expand/collapse can take its place on hover.
    renderRow: (c: QueueRow) => (
      <SidebarConversationItem conv={c} muted={c.isBlocked} dot={false} />
    ),
    renderLeading: (c: QueueRow) => <SidebarConversationDot conv={c} />,
    size: "sm",
    // A supervisor's expand/collapse sits in its status dot's place, shown
    // only on hover (Pages / file-explorer style) — this list only; the rest
    // of the agent manager's trees keep the app's disclosure look.
    disclosureVariant: "merged",
  },
};

/** Task-groups collapse to one representative in the ranked/working sections. */
const QUEUE_AGGREGATE: DataViewAggregateConfig<QueueRow> = {
  getKey: (r) =>
    takesFiledRows(r.section) || r.section === "working" ? r.taskId : null,
  pickRepresentative: (m) =>
    m.find((x) => x.status === "working" || x.status === "starting") ??
    m.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)),
};
