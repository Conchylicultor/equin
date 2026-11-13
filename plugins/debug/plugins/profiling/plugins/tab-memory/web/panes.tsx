import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { TabMemoryPanel } from "./components/tab-memory-panel";

export const tabMemoryPane = Pane.define({
  title: "Tab memory",
  route: defineRoute({ id: "debug-tab-memory", segment: "tab-memory" }),
  app: debugApp,
  component: TabMemoryBody,
});

function TabMemoryBody(): ReactElement {
  return (
    <PaneChrome pane={tabMemoryPane} inset="document">
      <TabMemoryPanel />
    </PaneChrome>
  );
}
