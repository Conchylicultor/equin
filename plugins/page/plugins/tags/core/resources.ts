import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { tagsField } from "@plugins/fields/plugins/tags/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";
import { TAG_COLORS } from "./tag-color";
import { pageTagIdKind } from "./tag-id";

/**
 * One vocabulary tag, as stored (`page_tags`). The table (server) and the wire
 * schema below both derive from this record, so the two cannot drift.
 *
 * `nameKey` (`pageTagServerFields`) is the name's identity (`tagKey`) — the
 * column the unique index sits on, so two spellings of one name cannot both be
 * stored. It is server-only: a reader that needs it derives it from `name` with
 * the same function.
 */
export const pageTagFields = {
  id: idKindField(pageTagIdKind),
  name: textField(),
  color: enumTextField(TAG_COLORS),
  createdAt: dateField(),
} satisfies FieldsRecord;

/** The vocabulary's server-only columns (beside the ref, never on the wire). */
export const pageTagServerFields = {
  nameKey: textField(),
} satisfies FieldsRecord;

/** The `page_tags` entity (its wire fields; `nameKey` is a server field). */
export const pageTagsEntityRef = entityRef("page_tags", pageTagFields);

/** One vocabulary tag, as the browser and the server read it. */
export const PageTagRowSchema = fieldsToZodObject(pageTagFields);
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

/**
 * How many tags the vocabulary may hold. It is read whole — every picker lists
 * it, every chip resolves against it — so it is capped rather than held
 * unbounded: the `all` set's schema and loader refuse past it, and the store
 * refuses a create that would cross it (400), so the bound holds by the
 * writes. A hand-curated vocabulary has tens of names.
 */
export const PAGE_TAG_VOCABULARY_MAX = 500;

/** The workspace's tag vocabulary, whole (at most {@link PAGE_TAG_VOCABULARY_MAX}). */
export const pageTagVocabulary = liveCollection("page-tags.vocabulary", {
  // The entity's wire record (its server-only `nameKey` is not on the ref).
  from: pageTagsEntityRef,
  carry: { pick: ["id", "name", "color", "createdAt"] },
  // Its wire rows stay the table's own columns: no extension exposes a tag.
  baseExposures: false,
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    max: PAGE_TAG_VOCABULARY_MAX,
  },
});

/**
 * Tagged pages' tags, by page id — lookup-only, never a whole set: one page's
 * header chips and picker read `useLive(pageTagAssignments, { id })`. A list
 * of pages reads its rows' tags off the rows themselves: the extension EXPOSES
 * `tags` on every list whose rows are blocks (the sidebar's dots and filters
 * read the `pages.tree.v2` window's `$columns`).
 */
export const pageTagAssignments = liveCollection("page-tags.assignments", {
  from: pageTagAssignmentShape,
  id: "pageId",
});
