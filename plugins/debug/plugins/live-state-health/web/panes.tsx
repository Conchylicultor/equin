import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { LiveStateHealth } from "./components/live-state-health";

export const liveStateHealthPane = Pane.define({
  title: "Live State",
  route: defineRoute({
    id: "live-state-health",
    segment: "live-state",
  }),
  app: debugApp,
  component: LiveStateHealthBody,
});

function LiveStateHealthBody(): ReactElement {
  return (
    <PaneChrome pane={liveStateHealthPane} inset="document">
      <LiveStateHealth />
    </PaneChrome>
  );
}
