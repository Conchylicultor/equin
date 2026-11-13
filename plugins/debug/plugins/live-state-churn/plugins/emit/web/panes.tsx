import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { EmitPane } from "./components/emit-pane";

export const liveStateEmitPane = Pane.define({
  title: "Live-State Emit",
  route: defineRoute({
    id: "debug-live-state-emit",
    segment: "live-state-emit",
  }),
  app: debugApp,
  component: LiveStateEmitBody,
});

function LiveStateEmitBody(): ReactElement {
  return (
    <PaneChrome pane={liveStateEmitPane} inset="document">
      <EmitPane />
    </PaneChrome>
  );
}
