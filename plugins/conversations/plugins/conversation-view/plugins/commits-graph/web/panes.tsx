import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { CommitsGraphBody } from "./components/commits-graph-body";

export const convCommitsGraphPane = Pane.define({
  route: defineRoute({
    id: "conv-commits-graph",
    segment: "commits",
  }),
  app: agentManagerApp,
  title: "Commits",
  // Conversation-scoped satellite: promote() would strip convId from the URL.
  chrome: { promote: false },
  component: ConvCommitsGraphBody,
});

function ConvCommitsGraphBody() {
  return (
    <PaneChrome pane={convCommitsGraphPane}>
      <CommitsGraphBody />
    </PaneChrome>
  );
}
