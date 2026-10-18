import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { accountsRoute } from "@plugins/auth/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { AppleSetupPane } from "./components/apple-setup-pane";

export const appleSetupPane = Pane.define({
  route: defineRoute({
    id: "apple-setup",
    segment: "apple/setup",
    parent: accountsRoute,
  }),
  app: settingsApp,
  component: AppleSetupPaneBody,
  title: "Set up Apple Signing",
  chrome: { history: false, close: true },
});

// The standard pane header (title, ×) like every pane an Accounts row opens.
function AppleSetupPaneBody() {
  return (
    <PaneChrome pane={appleSetupPane}>
      <AppleSetupPane />
    </PaneChrome>
  );
}
