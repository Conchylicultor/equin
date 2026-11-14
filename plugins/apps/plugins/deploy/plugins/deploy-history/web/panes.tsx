import type { ReactElement } from "react";
import {
  defineRoute,
  Pane,
  PaneChrome,
} from "@plugins/primitives/plugins/pane/web";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { ActivityPage } from "./components/activity-page";

/**
 * `/deploy/activity` — declared here, beside the one pane that answers it,
 * rather than in a `core/`: only this plugin's own sidebar entry opens it, so
 * no other plugin builds the URL. A root of its own, like a site: opened from
 * the sidebar, it replaces the page on screen (Miller draws a parent as a
 * column).
 */
const activityRoute = defineRoute({
  id: "deploy-activity",
  segment: "activity",
});

/** Every deploy run across every site, as one multi-view list. */
export const activityPane = Pane.define({
  title: "Activity",
  route: activityRoute,
  app: deployApp,
  component: ActivityBody,
});

function ActivityBody(): ReactElement {
  return (
    <PaneChrome pane={activityPane}>
      <ActivityPage />
    </PaneChrome>
  );
}
