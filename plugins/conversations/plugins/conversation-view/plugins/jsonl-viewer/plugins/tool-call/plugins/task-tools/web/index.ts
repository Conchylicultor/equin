import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { TaskCreateToolView } from "./components/task-create-tool-view";
import { TaskUpdateToolView } from "./components/task-update-tool-view";
import { TaskGetToolView } from "./components/task-get-tool-view";
import { TaskListToolView } from "./components/task-list-tool-view";
import { TaskOutputToolView } from "./components/task-output-tool-view";
import { TaskStopToolView } from "./components/task-stop-tool-view";
import { TaskProgressOverlay } from "./components/task-progress-overlay";
import {
  TaskCreateInputSchema,
  TaskListInputSchema,
  TaskRefInputSchema,
  TaskUpdateInputSchema,
} from "../core";

export default {
  description:
    "Renders TaskCreate/Update/Get/List/Output/Stop tool calls with a sticky progress overlay.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "TaskCreate",
      icon: symbol("check-box"),
      input: TaskCreateInputSchema,
      component: TaskCreateToolView,
    }),
    JsonlViewerTool.Renderer({
      match: "TaskUpdate",
      icon: symbol("checklist"),
      input: TaskUpdateInputSchema,
      component: TaskUpdateToolView,
    }),
    JsonlViewerTool.Renderer({
      match: "TaskGet",
      icon: symbol("checklist"),
      input: TaskRefInputSchema,
      component: TaskGetToolView,
    }),
    JsonlViewerTool.Renderer({
      match: "TaskList",
      icon: symbol("checklist"),
      input: TaskListInputSchema,
      component: TaskListToolView,
    }),
    JsonlViewerTool.Renderer({
      match: "TaskOutput",
      icon: symbol("checklist"),
      input: TaskRefInputSchema,
      component: TaskOutputToolView,
    }),
    JsonlViewerTool.Renderer({
      match: "TaskStop",
      icon: symbol("stop"),
      input: TaskRefInputSchema,
      component: TaskStopToolView,
    }),
    JsonlViewer.Overlay({
      id: "task-progress",
      component: TaskProgressOverlay,
    }),
  ],
} satisfies PluginDefinition;
