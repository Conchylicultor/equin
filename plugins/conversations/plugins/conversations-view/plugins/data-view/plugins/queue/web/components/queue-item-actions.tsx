import { createContext, useContext, type ReactElement } from "react";

import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  promoteQueue,
  demoteQueue,
  stepDownQueue,
  rerankQueue,
  pinQueue,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import type { ConversationSidebarProps } from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import type { QueueRow } from "./use-queue-rows";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");
const keyboardDoubleArrowDownIcon = symbol("keyboard-double-arrow-down");
const libraryAddIcon = symbol("library-add");
const keepIcon = symbol("keep");
const verticalAlignBottomIcon = symbol("vertical-align-bottom");
const verticalAlignTopIcon = symbol("vertical-align-top");

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
 * Pin / unpin the row's task-group. Pinning lifts it into the Pinned section at
 * the top of the queue; it stays an ordinary queue member, so unpinning drops it
 * back into the same place it held.
 *
 * Offered on every live section — including Working, so a group that starts
 * running can still be pinned for when it comes back — but never on the closed
 * conversations under Done, nor on Lost ones (never ranked).
 */
export function PinAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  // A lost conversation is never ranked, so a pin would have nothing to lift.
  if (
    row.section === "done" ||
    row.section === "failed" ||
    row.section === "disconnected" ||
    row.section === "lost"
  )
    return null;
  return (
    <IconButton
      icon={keepIcon}
      active={row.pinned}
      label={row.pinned ? "Unpin" : "Pin to top"}
      onClick={(e) => {
        e.stopPropagation();
        return fetchEndpoint(
          pinQueue,
          {},
          {
            body: { conversationId: row.id, pinned: !row.pinned },
          },
        );
      }}
    />
  );
}

/** Move the row's task-group to the top of its section. */
export function PromoteAction({
  row,
}: ItemActionProps<QueueRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  if ((row.section !== "queued" && row.section !== "pinned") || row.isTop)
    return null;
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
  if ((row.section !== "pinned" && row.section !== "queued") || row.isBottom)
    return null;
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
