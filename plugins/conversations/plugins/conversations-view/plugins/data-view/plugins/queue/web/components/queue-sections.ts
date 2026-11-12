import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import {
  PINNED_SECTION,
  conversationSectionIdKind,
  type ConversationSectionId,
  type QueueSectionKey,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import type { QueueRow } from "./use-queue-rows";

/** A user-made section as the sidebar draws it: its id and name, in rank order. */
export interface QueueUserSection {
  id: ConversationSectionId;
  name: string;
}

/** Whether a section key (the `section` field's group key) is a user section. */
export function isUserSection(
  key: string | null,
): key is ConversationSectionId {
  return key !== null && conversationSectionIdKind.is(key);
}

/**
 * Where a row dropped into the section keyed `groupKey` is filed — the
 * `section` the `file` / `reorder` endpoints take: Pinned, a user section, or
 * `null` (the Queue). `undefined` for every other section (Working, Done, …):
 * read-time partitions nothing can be filed into.
 */
export function filedSectionOf(
  groupKey: string | null,
): QueueSectionKey | undefined {
  if (groupKey === "queued") return null;
  if (groupKey === "pinned") return PINNED_SECTION;
  if (isUserSection(groupKey)) return groupKey;
  return undefined;
}

/** Whether a row can be moved into the section keyed `groupKey`. */
export function takesFiledRows(groupKey: string | null): boolean {
  return filedSectionOf(groupKey) !== undefined;
}

/**
 * The synthetic `section` field that drives the read-time partitioning — the
 * one field the Queue computes itself (`extraFields`); every other is derived
 * from its collection. Its options are the sections in display order: Pinned,
 * the user's own sections (rank order, drawn even when empty —
 * `alwaysGroup`), then the built-in read-time ones.
 */
export function queueSectionField(
  sections: readonly QueueUserSection[],
): FieldDef<QueueRow> {
  return {
    id: "section",
    label: "Section",
    type: "enum",
    value: (r) => r.section,
    groupable: true,
    filterable: false,
    options: [
      { value: "pinned", label: "Pinned" },
      ...sections.map((s) => ({
        value: s.id,
        label: s.name,
        alwaysGroup: true as const,
      })),
      { value: "queued", label: "Queue" },
      { value: "working", label: "Working" },
      { value: "lost", label: "Lost" },
      { value: "unranked", label: "Unranked" },
      { value: "failed", label: "Failed to start" },
      { value: "disconnected", label: "Disconnected" },
      { value: "done", label: "Done" },
    ],
  };
}

/**
 * The section a row is filed into, as one of the sidebar's choices: Pinned, a
 * KNOWN user section, or the Queue (`null`) — a section id no longer known
 * reads as the Queue, exactly as `classifyQueue` draws it.
 */
export function currentFiledSection(
  filed: string | null,
  sections: readonly QueueUserSection[],
): QueueSectionKey {
  if (filed === PINNED_SECTION) return PINNED_SECTION;
  if (isUserSection(filed) && sections.some((s) => s.id === filed))
    return filed;
  return null;
}
