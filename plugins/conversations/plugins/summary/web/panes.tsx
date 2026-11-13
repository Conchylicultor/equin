import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { SummaryPane } from "./components/summary-pane";

export const convSummaryPane = Pane.define({
  route: defineRoute({
    id: "conv-summary",
    segment: "summary",
  }),
  app: agentManagerApp,
  title: "Summary",
  component: ConvSummaryBody,
  // Conversation-scoped satellite: promote() would strip convId from the URL.
  chrome: { history: false, promote: false },
});

function ConvSummaryBody() {
  return (
    <PaneChrome pane={convSummaryPane} inset="document">
      <SummaryPane />
    </PaneChrome>
  );
}
