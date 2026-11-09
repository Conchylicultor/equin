import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { AgentReportPaneBody } from "./components/agent-report-pane";

export const agentReportPane = Pane.define({
  route: defineRoute({
    id: "agent-report",
    // `by` is a SubagentRef's key kind: `call` (the parent's Agent tool-use id)
    // or `agent` (the sub-agent's own id). The body parses it.
    segment: "agent-report/:by/:key",
  }),
  app: agentManagerApp,
  component: AgentReportPaneBody,
  title: "Sub-agent",
  // Conversation-scoped satellite: promote() would strip convId from the URL.
  chrome: { history: false, promote: false },
  useResolve: false,
});
