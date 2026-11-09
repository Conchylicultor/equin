import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { PushProfilingPaneBody } from "./components/push-profiling-pane";

export const convPushProfilingPane = Pane.define({
  route: defineRoute({
    id: "conv-push-profiling",
    segment: "pp",
  }),
  app: agentManagerApp,
  title: "Op Profiling",
  // Conversation-scoped satellite: promote() would strip convId from the URL.
  chrome: { promote: false },
  component: ConvPushProfilingBody,
});

function ConvPushProfilingBody() {
  return (
    <PaneChrome pane={convPushProfilingPane}>
      <PushProfilingPaneBody />
    </PaneChrome>
  );
}
