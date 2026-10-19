import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { CONVERSATION_RUNTIMES } from "@plugins/conversations/plugins/runtime-catalog/core";
import { runtimeLaunchOption } from "../core";
import { RuntimeLaunchControl } from "./components/runtime-control";
import { RuntimePillMenu, RuntimePillValue } from "./components/runtime-pill";
import { useTaskRuntimeBinding } from "./internal/binding";

export default {
  description:
    "Runtime picker as a launch option: which runtime the task's conversations start on — the configured default, the interactive CLI in tmux, or a headless Agent SDK session — on the task-draft composer (a pill) and the task detail's Prompt card.",
  contributions: [
    TaskLaunch.Option({
      id: runtimeLaunchOption.id,
      label: "Runtime",
      description:
        "What the agent runs on: the interactive Claude Code CLI in a terminal, or a headless Agent SDK session. Default follows Settings.",
      def: runtimeLaunchOption,
      component: RuntimeLaunchControl,
      pill: {
        icon: symbol("terminal"),
        Value: RuntimePillValue,
        MenuGroup: RuntimePillMenu,
        side: "start",
      },
      useTaskBinding: useTaskRuntimeBinding,
      summarize: (runtime) =>
        runtime ? CONVERSATION_RUNTIMES[runtime].label : null,
    }),
  ],
} satisfies PluginDefinition;
