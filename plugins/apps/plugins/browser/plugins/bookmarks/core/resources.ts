import { entityRef } from "@plugins/infra/plugins/entities/core";
import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { bookmarkIdKind } from "./id-kind";

// One row per bookmark. The `browser_bookmarks` table and this wire schema both
// derive from `bookmarkFields` (via defineEntity on the server), so a
// column/schema drift is unrepresentable and every row field binds to its
// column by name. `createdAt` is a coerced Date on the wire.
export const bookmarkFields = {
  id: idKindField(bookmarkIdKind),
  url: textField({ label: "URL" }),
  title: textField(),
  createdAt: dateField(),
} satisfies FieldsRecord;

/** The `browser_bookmarks` entity. */
export const browserBookmarksEntityRef = entityRef(
  "browser_bookmarks",
  bookmarkFields,
);

export const BookmarkRowSchema = fieldsToZodObject(bookmarkFields);
export type BookmarkRow = z.infer<typeof BookmarkRowSchema>;

// The bookmarks, as a live collection: a bounded window (oldest first, 100 /
// max 500 — the bar and the start page read the default window and grow it
// with `loadMore`) plus its `:rows` point sibling. `createdAt` is
// insert-immutable, so a title edit never reorders a window.
//
// `url` is filterable for the star: "is THIS page bookmarked?" is a
// `{ where: { url }, limit: 1 }` read answered by the server, never a scan of
// the default window, which would miss a bookmark past its first 100 rows.
export const browserBookmarks = liveCollection("browser-bookmarks", {
  from: browserBookmarksEntityRef,
  pick: ["url"],
  carry: { pick: ["id", "title", "createdAt"] },
  // Its wire rows stay the table's own columns: no extension exposes a bookmark.
  baseExposures: false,
  id: "id",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "asc"]], limit: 100 },
  maxLimit: 500,
});
