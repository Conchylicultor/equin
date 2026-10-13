import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The notifications pane (`/debug/notifications`): every undismissed
 * notification as a DataView — the bell popover's "View all". Declared in core
 * so the bell links to it with `notificationsRoute.link(debugApp, {})`.
 */
export const notificationsRoute = defineRoute({
  id: "notifications",
  segment: "notifications",
});
