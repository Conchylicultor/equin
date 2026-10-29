import type { ReactElement } from "react";
import {
  defineRoute,
  Pane,
  PaneChrome,
} from "@plugins/primitives/plugins/pane/web";
import {
  deployApp,
  deployIndexRoute,
} from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { ActivityPage } from "./components/activity-page";

/**
 * `/deploy/activity` — declared here, beside the one pane that answers it,
 * rather than in a `core/`: only this plugin's own sidebar entry opens it, so
 * no other plugin builds the URL. Parented on the app's index, like a site.
 */
const activityRoute = defineRoute({
  id: "deploy-activity",
  segment: "activity",
  parent: deployIndexRoute,
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
