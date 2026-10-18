import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { accountsRoute } from "@plugins/auth/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { GoogleMapsSetupPane } from "./components/google-maps-setup-pane";

export const googleMapsSetupPane = Pane.define({
  route: defineRoute({
    id: "google-maps-setup",
    segment: "google-maps/setup",
    parent: accountsRoute,
  }),
  app: settingsApp,
  component: GoogleMapsSetupPaneBody,
  title: "Set up Google Maps",
  chrome: { history: false, close: true },
});

// The standard pane header (title, ×) like every pane an Accounts row opens.
function GoogleMapsSetupPaneBody() {
  return (
    <PaneChrome pane={googleMapsSetupPane}>
      <GoogleMapsSetupPane />
    </PaneChrome>
  );
}
