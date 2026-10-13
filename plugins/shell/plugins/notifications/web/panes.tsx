import type { ReactElement } from "react";
import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { notificationsRoute } from "../core";
import { NotificationsView } from "./components/notifications-view";

/**
 * Debug → Notifications (`/debug/notifications`): every undismissed
 * notification, where the bell popover's "View all" leads. It lives in the
 * Debug app beside the other observability surfaces (Reports, Builds), like the
 * build popover's "Open in Debug".
 */
export const notificationsPane = Pane.define({
  title: "Notifications",
  route: notificationsRoute,
  app: debugApp,
  component: NotificationsPaneBody,
});

function NotificationsPaneBody(): ReactElement {
  return (
    <PaneChrome pane={notificationsPane}>
      <NotificationsView />
    </PaneChrome>
  );
}
