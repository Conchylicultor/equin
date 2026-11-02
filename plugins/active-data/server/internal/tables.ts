import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { activeDataBindingsEntityRef } from "../../core";

// Per-widget persistent state for active-data block tags. The card itself
// (e.g. <task>…</task>) is in immutable assistant text, so the model emits
// the "intent"; the user's follow-up action (created task, launched conv) is
// stored here keyed by the widget's stable position in the message. Cascades
// on conversation delete — we don't keep bindings for dropped conversations.
//
// Declared through `defineEntity` from the one field record in
// `../../core/resource.ts`, so the live read (`activeDataBindings`) is a
// collection `from` it — the same DDL the hand-written `pgTable` had.
// `updatedAt` is derived: the trigger bumps it only when `payload` changes.
export const activeDataBindingsEntity = defineEntity(
  activeDataBindingsEntityRef,
  {
    primaryKey: ["conversationId", "messageId", "tag", "occurrenceIndex"],
    columns: {
      conversationId: {
        references: { column: () => _conversations.id, onDelete: "cascade" },
      },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    updatedAt: {
      touchedBy: {
        payload: true,
        conversationId: false,
        messageId: false,
        tag: false,
        occurrenceIndex: false,
        createdAt: false,
      },
    },
  },
);

// drizzle-kit schema-glob discovery, and the name every writer uses.
export const _activeDataBindings = activeDataBindingsEntity.table;
