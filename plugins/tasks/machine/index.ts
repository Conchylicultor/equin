import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleLaunchTask } from "./internal/handle-launch-task";
import { repoInfoServed } from "./internal/repo-info";
import {
  autoStartReconcileWarmup,
  startRelaunchOnClaudeReady,
  stopRelaunchOnClaudeReady,
} from "./internal/auto-start-reconcile";
import { addTaskTool } from "./internal/mcp-tools";
import { tasksFileCapability } from "./internal/tasks-file-capability";
import {
  taskTreeTool,
  tasksDigestAnnotation,
  treeDigestInstructions,
} from "./internal/tree-digest";
import { tasksWatchSources } from "./internal/watch-sources";
import { launchTask } from "../core/endpoints";

export default {
  description:
    "Nested tasks, desktop-only half: the launch route (file a task with its launch options and start its agent now), which spawns Claude Code in a checkout of this repo; the `tasks.repo-info` read (the main checkout's GitHub remote); the `add_task` and `task_tree` MCP tools and the `tree-digest` instructions section (gated on the `tasks.file` grant); and the main backend's auto-start catch-up (a boot warm-up and a relaunch when Claude Code turns ready) that wakes the launcher for every armed task.",
  contributions: [
    ...repoInfoServed.declare,
    tasksFileCapability,
    tasksDigestAnnotation,
    ...tasksWatchSources,
  ],
  httpRoutes: {
    [launchTask.route]: handleLaunchTask,
  },
  register: [
    addTaskTool,
    taskTreeTool,
    treeDigestInstructions,
    autoStartReconcileWarmup,
  ],
  onReady: () => {
    startRelaunchOnClaudeReady();
  },
  onShutdown: () => {
    stopRelaunchOnClaudeReady();
  },
} satisfies MachinePluginDefinition;
