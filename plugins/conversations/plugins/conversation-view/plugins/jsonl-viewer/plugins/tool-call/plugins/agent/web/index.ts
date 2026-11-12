import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { TaskNotification } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/task-notification/web";
import { AgentToolView } from "./components/agent-tool-view";
import { useSubagentNotificationClaim } from "./internal/use-subagent-claim";
import { agentReportPane } from "./panes";
import { AGENT_TOOL_NAME } from "../core";

export { agentReportPane } from "./panes";

export default {
  description:
    "Renders Agent tool calls with subagent type, model badge, prompt (markdown), and report (markdown).",
  contributions: [
    JsonlViewerTool.Renderer({
      match: AGENT_TOOL_NAME,
      icon: symbol("auto-awesome"),
      component: AgentToolView,
    }),
    Pane.Register({ pane: agentReportPane }),
    TaskNotification.Open({
      id: "sub-agent",
      useClaim: useSubagentNotificationClaim,
    }),
  ],
  slots: { "agent-report": agentReportPane },
} satisfies PluginDefinition;
