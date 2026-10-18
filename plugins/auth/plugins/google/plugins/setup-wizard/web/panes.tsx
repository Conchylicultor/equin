import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { accountsRoute } from "@plugins/auth/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { GoogleSetupPane } from "./components/google-setup-pane";

export const googleSetupPane = Pane.define({
  route: defineRoute({
    id: "google-setup",
    segment: "google/setup",
    parent: accountsRoute,
  }),
  app: settingsApp,
  component: GoogleSetupPaneBody,
  title: "Connect Google",
  chrome: { history: false, close: true },
});

// The standard pane header (title, ×) like every pane an Accounts row opens.
function GoogleSetupPaneBody() {
  return (
    <PaneChrome pane={googleSetupPane}>
      <GoogleSetupPane />
    </PaneChrome>
  );
}
