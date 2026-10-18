import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { accountsRoute } from "@plugins/auth/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { LiveMapSetupPane } from "./components/live-map-setup-pane";

// Owned here, not by `auth/google-maps/setup-wizard`: this plugin already
// imports that wizard (for the Places affordance), so a wizard importing this
// plugin's browser-config contract back would be a cycle.
export const liveMapSetupPane = Pane.define({
  route: defineRoute({
    id: "google-maps-live-map-setup",
    segment: "google-maps/live-map",
    parent: accountsRoute,
  }),
  app: settingsApp,
  component: LiveMapSetupPaneBody,
  title: "Live map",
  chrome: { history: false, close: true },
});

// The standard pane header (title, ×) like every pane an Accounts row opens.
function LiveMapSetupPaneBody() {
  return (
    <PaneChrome pane={liveMapSetupPane}>
      <LiveMapSetupPane />
    </PaneChrome>
  );
}
