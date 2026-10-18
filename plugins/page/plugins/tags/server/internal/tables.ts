import { uniqueIndex } from "drizzle-orm/pg-core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import {
  pageTagAssignmentShape,
  pageTagServerFields,
  pageTagsEntityRef,
} from "../../core";

// `page_tags`: the workspace vocabulary. A tag's identity is its normalized
// name (`name_key`, `tagKey`), unique, so `In progress` and `in  progress`
// can never be two tags — the database and every resolver agree on one key.
export const pageTags = defineEntity(pageTagsEntityRef, pageTagServerFields, {
  primaryKey: "id",
  columns: { createdAt: { default: defaultNow() } },
  indexes: (t) => [uniqueIndex("page_tags_name_key_idx").on(t.nameKey)],
});
// drizzle-kit schema-glob discovery.
export const _pageTags = pageTags.table;

// `page_blocks_ext_tags`: one row per TAGGED page — its tag ids, in the order
// the page shows them. FK-cascades with the page row, so purging a page drops
// its tags; a TRASHED page keeps them (they come back with a restore).
export const pageBlocksTags = defineExtension(
  _blocks,
  "tags",
  pageTagAssignmentShape,
);
// drizzle-kit schema-glob discovery.
export const _pageBlocksTagsExt = pageBlocksTags.table;
