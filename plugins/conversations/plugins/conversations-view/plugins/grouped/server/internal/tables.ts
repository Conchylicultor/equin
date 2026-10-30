import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { rankText } from "@plugins/primitives/plugins/rank/core";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { idColumn } from "@plugins/ids/server";
import { conversationGroupIdKind } from "../../core";

// User-defined groupings shown in the conversation sidebar list. Each
// conversation can be a member of at most one group (PK on conversation_id).
// Groups persist even when empty — the user explicitly removes them.
export const _conversationGroups = deriveUpdatedAt(
  pgTable("conversation_groups", {
    id: idColumn(conversationGroupIdKind),
    title: text("title").notNull(),
    expanded: boolean("expanded").notNull().default(true),
    rank: rankText("rank").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  }),
  // `expanded` is view state, not a fact about the group.
  {
    touchedBy: {
      title: true,
      rank: true,
      id: false,
      expanded: false,
      createdAt: false,
    },
  },
);

export const _conversationGroupMembers = pgTable(
  "conversation_group_members",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => _conversations.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => _conversationGroups.id, { onDelete: "cascade" }),
    rank: rankText("rank").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("cgm_group_rank_idx").on(t.groupId, t.rank)],
);
