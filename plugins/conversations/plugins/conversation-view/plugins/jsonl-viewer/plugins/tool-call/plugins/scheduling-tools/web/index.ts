import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
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
      icon: symbol("schedule"),
      component: ScheduleWakeupToolView,
      partialInput: true,
    }),
    JsonlViewerTool.Renderer({
      match: "Monitor",
      icon: symbol("monitoring"),
      component: MonitorToolView,
      partialInput: true,
    }),
  ],
} satisfies PluginDefinition;
