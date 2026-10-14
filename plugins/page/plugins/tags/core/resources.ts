import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import type { FieldsRecord } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { tagsField } from "@plugins/fields/plugins/tags/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { wireSchema } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";
import { TAG_COLORS } from "./tag-color";
import { pageTagIdKind } from "./tag-id";

/**
 * One vocabulary tag, as stored (`page_tags`). The table (server) and the wire
 * schema below both derive from this record, so the two cannot drift.
 *
 * `nameKey` is the name's identity (`tagKey`) — the column the unique index sits
 * on, so two spellings of one name cannot both be stored. It is server-only:
 * a reader that needs it derives it from `name` with the same function.
 */
export const pageTagFields = {
  id: idKindField(pageTagIdKind),
  name: textField(),
  nameKey: textField(),
  color: enumTextField(TAG_COLORS),
  createdAt: dateField(),
} satisfies FieldsRecord;

/** The vocabulary's server-only columns. */
export const PAGE_TAG_SERVER_ONLY = ["nameKey"] as const;

/** One vocabulary tag, as the browser and the server read it. */
export const PageTagRowSchema = wireSchema(pageTagFields, PAGE_TAG_SERVER_ONLY);
export type PageTagRow = z.infer<typeof PageTagRowSchema>;

/**
 * The tags one page carries, in the order the page shows them — the
 * `page_blocks_ext_tags` entity extension (`server/internal/tables.ts`), keyed
 * on the page's id. One row per TAGGED page: a page with no tags has no row
 * (writing `[]` deletes it).
 *
 * `tagIds` is a tags field (a `jsonb` string array, the column it always was)
 * and is EXPOSED, under the id `tags`, to every list whose rows are blocks —
 * the pages sidebar filters and groups by it. Its options are the vocabulary,
 * read live (`web/internal/presentation.ts`); it declares no default, so an
 * untagged page reads NULL there — no tags.
 */
export const pageTagAssignmentShape = defineExtensionShape({
  key: "pageId",
  fields: { tagIds: tagsField({ label: "Tags" }) },
  exposes: {
    parent: pagesEntityRef,
    name: "tags",
    fields: { tagIds: { as: "tags" } },
  },
});
export const PageTagAssignmentRowSchema = pageTagAssignmentShape.schema;
export type PageTagAssignmentRow = z.infer<typeof PageTagAssignmentRowSchema>;

/** The workspace's tag vocabulary, whole. */
export const pageTagVocabulary = liveCollection("page-tags.vocabulary", {
  row: PageTagRowSchema,
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    unbounded: {
      reason:
        "the tag vocabulary is user-curated and small (tens of names); every picker lists it whole",
    },
  },
});

/**
 * Every tagged page's tags, whole. The sidebar marks and filters every page by
 * its tags, and `pages.tree` — what it renders — is already whole-set; this is
 * at most one row per page and usually a handful.
 */
export const pageTagAssignments = liveCollection("page-tags.assignments", {
  row: PageTagAssignmentRowSchema,
  id: "pageId",
  all: {
    orderBy: [["pageId", "asc"]],
    unbounded: {
      reason:
        "one row per TAGGED page, read whole by the sidebar beside the whole-set pages.tree",
    },
  },
});
