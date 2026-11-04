import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { EditTaskView } from "./components/edit-task-view";
import { DropTaskView } from "./components/drop-task-view";
import { TaskTreeView } from "./components/task-tree-view";
import { ListAgentsView } from "./components/list-agents-view";
import { MessageAgentView } from "./components/message-agent-view";

export default {
  description:
    "Renders the task-orchestration MCP tool calls an agent manages its task tree with: edit_task (the task's chip and the edit in words — renamed, prerequisites added or removed, armed or disarmed; the new title, description and dependency chips inside), drop_task (the dropped task's chip), task_tree (the tree as the agent read it — status icon, title, track and start words, indented, each row opening the task), list_agents (each agent's standing dot, task title and standing, each row opening its conversation) and message_agent (the recipient's chip, the message's first line, then the message and how it was delivered). A refusal turns the card to its error tone and shows the tool's reason.",
  contributions: [
    JsonlViewerTool.Renderer({ match: /edit_task$/, component: EditTaskView }),
    JsonlViewerTool.Renderer({ match: /drop_task$/, component: DropTaskView }),
    JsonlViewerTool.Renderer({ match: /task_tree$/, component: TaskTreeView }),
    JsonlViewerTool.Renderer({
      match: /list_agents$/,
      component: ListAgentsView,
    }),
    JsonlViewerTool.Renderer({
      match: /message_agent$/,
      component: MessageAgentView,
    }),
  ],
} satisfies PluginDefinition;
