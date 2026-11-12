import { createContext, useContext, type ReactElement } from "react";

import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  promoteQueue,
  demoteQueue,
  stepDownQueue,
  rerankQueue,
  fileQueue,
  PINNED_SECTION,
  type QueueSectionKey,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import type { ConversationSidebarProps } from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import type { QueueRow } from "./use-queue-rows";
import { currentFiledSection, takesFiledRows } from "./queue-sections";
import { useQueueSections } from "./queue-section-controls";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");
const keyboardDoubleArrowDownIcon = symbol("keyboard-double-arrow-down");
const libraryAddIcon = symbol("library-add");
const keepIcon = symbol("keep");
const verticalAlignBottomIcon = symbol("vertical-align-bottom");
const verticalAlignTopIcon = symbol("vertical-align-top");
const moveToIcon = symbol("drive-file-move");
const sectionIcon = symbol("label");
const queueIcon = symbol("low-priority");
const addIcon = symbol("add");

/** Per-consumer trailing-action slot for the Queue source's rows. */
export const QueueItemActions = defineItemActions<QueueRow>();

/**
 * The per-render close handler cannot ride on `itemActions` props (item-action
 * components receive only `{ row, hasChildren }`), so it is threaded through this
 * module-scoped context, provided by {@link QueueSource}. Mirrors the History
 * source's `CloseConversationContext`.
 */
export const CloseConversationContext = createContext<
  ConversationSidebarProps["onCloseConversation"] | null
>(null);

/**
 * Pin / unpin the row's task-group: file it into the built-in Pinned section at
 * the top of the queue, or back to the Queue. It stays an ordinary queue member,
 * so unpinning drops it back into the same place it held.
 *
 * Offered on every live section — including Working, so a group that starts
 * running can still be pinned for when it comes back — but never on the closed
 * conversations under Done, nor on Lost ones (never ranked).
 */
export function PinAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  const pinned = row.filedSection === PINNED_SECTION;
  if (!isFileable(row)) return null;
  return (
    <IconButton
      icon={keepIcon}
      active={pinned}
      label={pinned ? "Unpin" : "Pin to top"}
      onClick={(e) => {
        e.stopPropagation();
        return fetchEndpoint(
          fileQueue,
          {},
          {
            body: {
              conversationId: row.id,
              section: pinned ? null : PINNED_SECTION,
            },
          },
        );
      }}
    />
  );
}

/**
 * Whether the row's task group can be filed into a section: every live
 * section's row — Working included, like the pin — but never a closed
 * conversation (Done, Failed to start, Disconnected), nor a Lost one (never
 * ranked, so nothing to file).
 */
function isFileable(row: QueueRow): boolean {
  return (
    row.section !== "done" &&
    row.section !== "failed" &&
    row.section !== "disconnected" &&
    row.section !== "lost"
  );
}

/**
 * Move to: file the row's task group into Pinned, one of the user's sections
 * or the Queue (the current one checked, and inert), or into a new section
 * (created holding it, its name field open). Offered wherever the pin is.
 */
export function MoveToAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const { sections, file, create } = useQueueSections();
  if (!isFileable(row)) return null;
  const current = currentFiledSection(row.filedSection, sections);
  const choice = (
    key: QueueSectionKey,
    label: string,
    icon: typeof sectionIcon,
  ): ReactElement => (
    <DropdownMenuCheckboxItem
      key={key ?? "queue"}
      checked={current === key}
      disabled={current === key}
      onCheckedChange={() => file(row.id, key)}
    >
      <Icon icon={icon} className="size-4" />
      {label}
    </DropdownMenuCheckboxItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<IconButton icon={moveToIcon} label="Move to…" />}
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          {choice(PINNED_SECTION, "Pinned", keepIcon)}
          {sections.map((s) => choice(s.id, s.name, sectionIcon))}
          {choice(null, "Queue", queueIcon)}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => create({ conversationId: row.id })}>
          <Icon icon={addIcon} className="size-4" />
          New section…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Move the row's task-group to the top of its section. */
export function PromoteAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  // Ranks are one global space, so the global top is the top of every
  // section the group can be filed in.
  if (!takesFiledRows(row.section) || row.isTop) return null;
  return (
    <IconButton
      icon={verticalAlignTopIcon}
      label="Move to top"
      onClick={(e) => {
        e.stopPropagation();
        return fetchEndpoint(
          promoteQueue,
          {},
          { body: { conversationId: row.id } },
        );
      }}
    />
  );
}

/** Step the row's task-group down five positions. */
export function StepDownAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  if (!row.canStepDown) return null;
  return (
    <IconButton
      icon={keyboardDoubleArrowDownIcon}
      label="Move down 5"
      onClick={(e) => {
        e.stopPropagation();
        return fetchEndpoint(
          stepDownQueue,
          {},
          { body: { conversationId: row.id, steps: 5 } },
        );
      }}
    />
  );
}

/** Move the row's task-group to the bottom of the queue. */
export function DemoteAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  if (!takesFiledRows(row.section) || row.isBottom) return null;
  return (
    <IconButton
      icon={verticalAlignBottomIcon}
      label="Move to bottom"
      onClick={(e) => {
        e.stopPropagation();
        return fetchEndpoint(
          demoteQueue,
          {},
          { body: { conversationId: row.id } },
        );
      }}
    />
  );
}

/** Seed a rank for an unranked (waiting) conversation, adding it to the queue. */
export function AddToQueueAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  if (row.section !== "unranked") return null;
  return (
    <IconButton
      icon={libraryAddIcon}
      label="Add to queue"
      onClick={(e) => {
        e.stopPropagation();
        return fetchEndpoint(
          rerankQueue,
          {},
          { body: { conversationId: row.id } },
        );
      }}
    />
  );
}

/** Close the conversation (all sections except Done). */
export function CloseAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const onCloseConversation = useContext(CloseConversationContext);
  if (row.section === "done" || !onCloseConversation) return null;
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
