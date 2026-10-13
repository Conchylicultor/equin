import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { NotificationSchema, NotificationsUnreadSchema } from "./schema";
import { countedUnreadFilterable } from "./unread";

// The undismissed notifications, as a live collection: a bounded window (newest
// first, 200 / max 500) plus its `:rows` and `:groups` siblings. The base
// membership (`dismissed = false`) is the server's `where`, so a dismiss is a
// membership exit; a resurface bumps `createdAt`, which the window's order
// signature re-floats, while a count/lastSeenAt-only dedup bump stays an
// in-place upsert. `preload: "boot"` hydrates the default window (`{ limit:
// "200" }`) in the boot snapshot — the bell is always mounted.
//
// The bell's chips group on `type` / `variant` (`useLive(notifications, {
// groupBy })`) and a picked chip reads a filtered window, so a type seen only in
// older rows still has a chip and lists all of its rows.
//
// The Debug → Notifications pane reads the same collection as a DataView: its
// `read` / `muted` / `variant` columns are `countedUnreadFilterable` (the ONE
// declaration the badge's predicate is written over), so the pane groups on
// `read` as server sections and filters on `muted`; `title` is its search box;
// `type` / `variant` are its facets.
export const notifications = liveCollection("notifications", {
  row: NotificationSchema,
  id: "id",
  filterable: {
    ...countedUnreadFilterable,
    type: liveText(),
    title: liveText(),
  },
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 200 },
  maxLimit: 500,
  preload: "boot",
});

// The bell's unread badge, counted over the WHOLE collection — not over the
// loaded window, which holds only the newest 200 rows, so unread errors older
// than those would otherwise never reach the badge. One small object (counted
// by `countedUnread`, split by variant), pushed whole on every change to the
// table. `preload: "boot"`: the boot snapshot hydrates it, so the bell paints
// the real count on its first frame.
export const notificationsUnread = liveValue("notifications.unread", {
  schema: NotificationsUnreadSchema,
  preload: "boot",
});
