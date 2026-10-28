import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { choiceLabel } from "@plugins/conversations/plugins/model-provider/core";
import { autoStartLaunchOption } from "../core";
import { AutoStartLaunchControl } from "./components/auto-start-control";
import {
  AutoStartPillValue,
  AutoStartPillMenu,
  AUTO_START_OFF_LABEL,
} from "./components/auto-start-pill";
import { useTaskAutoStartBinding } from "./internal/binding";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Auto-start model picker as a launch option: the same controlled select on the task detail's Prompt card (bound to the task's row) and on the task-draft popover (bound to the draft card).",
  contributions: [
    TaskLaunch.Option({
      id: autoStartLaunchOption.id,
      label: "Auto-start",
      description:
        "Launch an agent on this task with the chosen model as soon as it is created, or once the tasks it runs after are done. Off leaves it for you to launch.",
      def: autoStartLaunchOption,
      component: AutoStartLaunchControl,
      // On a composer bar it fuses with the thinking mode into the one run
      // pill — `✦ Opus 5  Max` — at the trailing end, where the bar reads as
      // "what happens when you submit".
      pill: {
        icon: symbol("auto-awesome"),
        Value: AutoStartPillValue,
        // Fused with the thinking mode, so it is always on screen: off it reads
        // "Off" rather than disappearing out from under the user.
        unsetLabel: AUTO_START_OFF_LABEL,
        MenuGroup: AutoStartPillMenu,
        cluster: "run",
        side: "end",
      },
      useTaskBinding: useTaskAutoStartBinding,
      summarize: (model) => (model ? choiceLabel(model) : null),
      // A model chosen = an agent launches on it (now or once unblocked).
      startsConversation: (model) => model !== null,
    }),
  ],
} satisfies PluginDefinition;
