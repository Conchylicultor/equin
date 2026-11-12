import { createContext, useContext, useMemo, useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  createQueueSection,
  deleteQueueSection,
  fileQueue,
  moveQueueSection,
  renameQueueSection,
  type ConversationSectionId,
  type PINNED_SECTION,
  type QueueSectionKey,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import type { QueueUserSection } from "./queue-sections";

/** The name a fresh section gets; its name field opens on it, selected. */
export const NEW_SECTION_NAME = "New section";

/**
 * The Queue's section writes, and the section whose name field is open — one
 * value shared by the list (`manualOrder`, `groupEdit`, `headerActions`) and
 * the rows' Move to menu, so every way of making a section ends the same way:
 * created, then its name field open.
 */
export interface QueueSectionControls {
  /** The user's own sections, in rank order. */
  sections: readonly QueueUserSection[];
  /** File a conversation's task group into a section (`null` = the Queue). */
  file: (conversationId: string, section: QueueSectionKey) => Promise<void>;
  /**
   * Create a section — right after `after` (a section, or Pinned for the first
   * place), else last — holding `conversationId`'s group when given; then open
   * its name field.
   */
  create: (opts: {
    after?: ConversationSectionId | typeof PINNED_SECTION;
    conversationId?: string;
  }) => Promise<void>;
  rename: (id: ConversationSectionId, name: string) => Promise<void>;
  move: (
    id: ConversationSectionId,
    dest: { targetId: ConversationSectionId; zone: "before" | "after" },
  ) => Promise<void>;
  /** Delete a section: its members go back to the Queue. */
  remove: (id: ConversationSectionId) => Promise<void>;
  /** The section whose name field is open. */
  renaming: string | null;
  setRenaming: (key: string | null) => void;
}

/** Bind the section writes to the subtree's transport, over `sections`. */
export function useQueueSectionControls(
  sections: readonly QueueUserSection[],
): QueueSectionControls {
  const fetchEndpoint = useFetchEndpoint();
  const [renaming, setRenaming] = useState<string | null>(null);
  // The writes depend on the transport alone, so a section change or an open
  // name field never changes their identity (the list memoizes on them).
  const writes = useMemo(
    (): Pick<
      QueueSectionControls,
      "file" | "create" | "rename" | "move" | "remove"
    > => ({
      file: (conversationId, section) =>
        fetchEndpoint(fileQueue, {}, { body: { conversationId, section } }),
      create: async ({ after, conversationId }) => {
        const { id } = await fetchEndpoint(
          createQueueSection,
          {},
          {
            body: {
              name: NEW_SECTION_NAME,
              ...(after === undefined ? {} : { after }),
              ...(conversationId === undefined ? {} : { conversationId }),
            },
          },
        );
        setRenaming(id);
      },
      rename: (id, name) =>
        fetchEndpoint(renameQueueSection, {}, { body: { id, name } }),
      move: (id, { targetId, zone }) =>
        fetchEndpoint(moveQueueSection, {}, { body: { id, targetId, zone } }),
      remove: (id) => fetchEndpoint(deleteQueueSection, {}, { body: { id } }),
    }),
    [fetchEndpoint],
  );
  return useMemo(
    (): QueueSectionControls => ({
      ...writes,
      sections,
      renaming,
      setRenaming,
    }),
    [writes, sections, renaming],
  );
}

/**
 * The section controls, for the rows' item actions (which receive only
 * `{ row }`), provided by `QueueSource` — like `CloseConversationContext`.
 */
export const QueueSectionsContext = createContext<QueueSectionControls | null>(
  null,
);

/** The enclosing `QueueSource`'s section controls; throws outside one. */
export function useQueueSections(): QueueSectionControls {
  const controls = useContext(QueueSectionsContext);
  if (!controls)
    throw new Error("useQueueSections: no QueueSectionsContext (QueueSource).");
  return controls;
}
