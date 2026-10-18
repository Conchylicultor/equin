import { index, uniqueIndex } from "drizzle-orm/pg-core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationCategoriesEntityRef } from "../../shared/schemas";

// One row per (conversation, category) assignment. NOT a 1:1 entity extension:
// a conversation carries one row per configured category, and `defineExtension`
// is structurally 1:1 (its sole primary key IS the parent id).
//
// The primary key is the derived `categoryRowId(conversationId, categoryId)`
// rather than a composite, because the `conversationCategories` lookup
// collection's row id must be a SINGLE-column primary key — see
// shared/row-id.ts and shared/schemas.ts. The unique index on the pair is the
// writer's guard that the derived id and the logical key can never disagree.
export const conversationCategoriesEntity = defineEntity(
  conversationCategoriesEntityRef,
  // `createdAt` is the server field: never on the wire.
  { createdAt: dateField() },
  {
    primaryKey: "id",
    columns: {
      conversationId: {
        references: { column: () => _conversations.id, onDelete: "cascade" },
      },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    indexes: (t) => [
      // The PK index serves point reads (`WHERE id IN (…)`); this one serves the
      // per-conversation reads (the classify job's "what is already set?") and the
      // per-category scan the commits stats does.
      index("conversation_categories_conversation_idx").on(t.conversationId),
      uniqueIndex("conversation_categories_conv_cat_idx").on(
        t.conversationId,
        t.categoryId,
      ),
    ],
    updatedAt: {
      touchedBy: {
        item: true,
        source: true,
        id: false,
        conversationId: false,
        categoryId: false,
        createdAt: false,
      },
    },
  },
);

export const _conversationCategories = conversationCategoriesEntity.table;
