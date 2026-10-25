import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { bookmarkIdKind } from "../core";
import { Browser } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { BookmarkStar } from "./components/bookmark-star";
import { BookmarksBar } from "./components/bookmarks-bar";

export { useBookmarks } from "./internal/use-bookmarks";
export { browserBookmarks, BookmarkRowSchema, type BookmarkRow } from "../core";

export default {
  description:
    "Browser bookmarks UI: a star toggle inside the address pill and a bookmarks bar of clickable chips below the omnibox.",
  contributions: [
    IdKinds.Kind({ kind: bookmarkIdKind }),
    Browser.OmniboxAction({ id: "bookmark-star", component: BookmarkStar }),
    Browser.SubBar({ id: "bookmarks-bar", component: BookmarksBar }),
  ],
} satisfies PluginDefinition;
