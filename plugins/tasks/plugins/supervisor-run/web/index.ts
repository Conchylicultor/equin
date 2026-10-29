import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { supervisorLaunchOption } from "../core";
import { SupervisorLaunchControl } from "./components/supervisor-control";
import {
  SUPERVISOR_LABEL,
  SupervisorPillMenu,
  SupervisorPillValue,
} from "./components/supervisor-pill";

export default {
  description:
    "The Supervisor launch option on every new-task composer (Home prompt, Make a wish, menu bar): Interactive (unset — the pill rests as its icon) or Supervisor. Draft-only — it decides how a task's tree runs when it is filed.",
  contributions: [
    TaskLaunch.Option({
      id: supervisorLaunchOption.id,
      label: "Supervisor",
      description:
        "Talk to a supervisor: an ordinary conversation that can also split the work into tasks and start agents on them, watching the whole tree. The agents it starts report back to it; you answer flags and review the branches.",
      def: supervisorLaunchOption,
      component: SupervisorLaunchControl,
      // Beside the prose, with the workspace and preprompt: it decides what
      // kind of work this is, not how the first agent runs.
      pill: {
        icon: symbol("account-tree"),
        Value: SupervisorPillValue,
        MenuGroup: SupervisorPillMenu,
        side: "start",
      },
      // No `useTaskBinding`: draft-only. A task's mandate is stated when it is
      // filed, never switched by hand afterwards.
      summarize: (supervisor) => (supervisor ? SUPERVISOR_LABEL : null),
    }),
  ],
} satisfies PluginDefinition;
