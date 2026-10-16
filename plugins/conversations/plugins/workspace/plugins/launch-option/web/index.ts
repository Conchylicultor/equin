import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { workspaceLaunchOption } from "../core";
import { WorkspaceLaunchControl } from "./components/workspace-control";
import {
  WorkspacePillMenu,
  WorkspacePillValue,
  worktreeIcon,
} from "./components/workspace-pill";
import { useTaskWorkspaceBinding } from "./internal/binding";

export default {
  description:
    "Workspace picker as a launch option: where the task's agent runs — the worktree, or one of the registered scratch profiles — on the task-draft composer (a pill whose menu lists every workspace, details on hover) and the task detail's Prompt card.",
  contributions: [
    TaskLaunch.Option({
      id: workspaceLaunchOption.id,
      label: "Workspace",
      description:
        "Where the agent runs: a worktree (a git checkout of this repo with its own database and deploy), or a scratch directory set up by a profile.",
      def: workspaceLaunchOption,
      component: WorkspaceLaunchControl,
      pill: {
        icon: worktreeIcon,
        Value: WorkspacePillValue,
        MenuGroup: WorkspacePillMenu,
        side: "start",
      },
      useTaskBinding: useTaskWorkspaceBinding,
      summarize: (spec) =>
        spec?.kind === "scratch" ? `Scratch: ${spec.profile}` : null,
    }),
  ],
} satisfies PluginDefinition;
