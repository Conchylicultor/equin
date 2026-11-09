import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { WorkflowNodePaneBody } from "./components/workflow-node-pane";
import { useWorkflowNodeTitle } from "./internal/use-workflow-node";

export const workflowNodePane = Pane.define({
  route: defineRoute({
    id: "workflow-node",
    segment: "workflow-node/:toolUseId/:nodeId",
  }),
  app: agentManagerApp,
  component: WorkflowNodePaneBody,
  // The step's label; `convId` comes from the conversation pane above this one.
  title: { useText: useWorkflowNodeTitle, fallback: "Workflow step" },
  // Conversation-scoped satellite: promote() would strip convId from the URL.
  chrome: { history: false, promote: false },
  useResolve: false,
});
