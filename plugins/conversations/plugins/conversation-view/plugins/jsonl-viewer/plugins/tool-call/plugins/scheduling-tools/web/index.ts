import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  MonitorToolView,
  ScheduleWakeupToolView,
} from "./components/scheduling-tool-views";

export default {
  description:
    "Renders the scheduling built-ins: ScheduleWakeup as 'in 20m — reason' (or 'stop loop') with its prompt inside, and Monitor as its description with the watched command and time limit.",
  contributions: [
    // Every input field is optional, so both fill in as the model writes them.
    JsonlViewerTool.Renderer({
      match: "ScheduleWakeup",
      component: ScheduleWakeupToolView,
      partialInput: true,
    }),
    JsonlViewerTool.Renderer({
      match: "Monitor",
      component: MonitorToolView,
      partialInput: true,
    }),
  ],
} satisfies PluginDefinition;
