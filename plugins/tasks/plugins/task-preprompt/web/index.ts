import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { prepromptLaunchOption } from "../core";
import { PrepromptLaunchControl } from "./components/preprompt-control";
import {
  PrepromptPillValue,
  PrepromptPillMenu,
} from "./components/preprompt-pill";
import { useTaskPrepromptBinding } from "./internal/binding";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { prepromptsConfig } from "@plugins/conversations/plugins/preprompts/web";

export { useTaskPreprompt } from "./hooks";

export default {
  description:
    "Per-task preprompt picker, contributed as a launch option of both the task detail's Prompt card and the task-draft popover; the selection is added to the agent's system prompt on launch.",
  contributions: [
    // A launch option, not a section: it configures the agent's first turn, so
    // it belongs beside the description and the Launch button rather than in
    // its own one-line card down the pane.
    TaskLaunch.Option({
      id: prepromptLaunchOption.id,
      label: "Preprompt",
      description:
        "A reusable set of instructions added to the agent's system prompt, such as a working style or a checklist to follow.",
      def: prepromptLaunchOption,
      component: PrepromptLaunchControl,
      // Its own pill on the leading half of a composer bar: a preprompt shapes
      // what the agent is told, which belongs beside the prose rather than with
      // the run controls.
      pill: {
        icon: symbol("article"),
        Value: PrepromptPillValue,
        MenuGroup: PrepromptPillMenu,
        // The rows are the preprompts library: a gear on the heading opens it.
        configure: prepromptsConfig,
        side: "start",
      },
      useTaskBinding: useTaskPrepromptBinding,
      // No `summarize`: a preprompt's human title lives in the `preprompts`
      // config, which only a hook can read — and the toast summary is a pure
      // function of the value. The id alone would be noise.
    }),
  ],
} satisfies PluginDefinition;
