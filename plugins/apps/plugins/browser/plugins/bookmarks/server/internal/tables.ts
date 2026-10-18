import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { browserBookmarksEntityRef } from "../../core";

// `browser_bookmarks`: one row per bookmarked URL, ordered by createdAt asc in
// the bookmarks bar. A plain table (not an entity extension) — bookmarks have
// no parent entity to hang off.
//
// The table + the `BookmarkRow` wire schema both derive from the single
// `bookmarkFields` record (core), so a column/schema drift is unrepresentable
// and `serveCollection` binds every row field to its column by name.
const browserBookmarks = defineEntity(browserBookmarksEntityRef, {
  primaryKey: "id",
  columns: {
    createdAt: { default: defaultNow() },
  },
});

// drizzle-kit schema-glob discovery. Name kept so consumers don't churn.
export const _browserBookmarks = browserBookmarks.table;
