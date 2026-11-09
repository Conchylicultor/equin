import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { ExplorerView } from "./components/explorer-view";

export const explorerPane = Pane.define({
  title: "Plugin",
  route: defineRoute({ id: "explorer", segment: "explorer" }),
  app: studioApp,
  component: ExplorerBody,
});

function ExplorerBody() {
  return (
    <PaneChrome pane={explorerPane}>
      <ExplorerView />
    </PaneChrome>
  );
}
