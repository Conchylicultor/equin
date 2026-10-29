import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { autonomousLaunchOption } from "../core";
import { AutonomousLaunchControl } from "./components/autonomous-control";
import {
  AUTONOMOUS_LABEL,
  AutonomousPillMenu,
  AutonomousPillValue,
} from "./components/autonomous-pill";

export default {
  description:
    "The Autonomous launch option on every new-task composer (Home prompt, Make a wish, menu bar): Interactive (unset — the pill rests as its icon) or Autonomous. Draft-only — it decides how a task's tree runs when it is filed.",
  contributions: [
    TaskLaunch.Option({
      id: autonomousLaunchOption.id,
      label: "Autonomous",
      description:
        "Run this as an autonomous run: its agents split the work into tasks, start them on their own, report back, and the agent on this task watches the whole tree. You answer flags and review the branches.",
      def: autonomousLaunchOption,
      component: AutonomousLaunchControl,
      // Beside the prose, with the workspace and preprompt: it decides what
      // kind of work this is, not how the first agent runs.
      pill: {
        icon: symbol("account-tree"),
        Value: AutonomousPillValue,
        MenuGroup: AutonomousPillMenu,
        side: "start",
      },
      // No `useTaskBinding`: draft-only. A task's mandate is stated when it is
      // filed, never switched by hand afterwards.
      summarize: (autonomous) => (autonomous ? AUTONOMOUS_LABEL : null),
    }),
  ],
} satisfies PluginDefinition;
