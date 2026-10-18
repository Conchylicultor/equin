import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleList } from "./internal/handle-list";
import { handleCreate } from "./internal/handle-create";
import { handleCreateChain } from "./internal/handle-create-chain";
import { handleClearAutoStart } from "./internal/handle-clear-auto-start";
import { handleSetAutoStart } from "./internal/handle-set-auto-start";
import { handleGet } from "./internal/handle-get";
import { handleUpdate } from "./internal/handle-update";
import { handleMove } from "./internal/handle-move";
import {
  handleAddDependency,
  handleRemoveDependency,
} from "./internal/handle-dependencies";
import { handleInsertBetween } from "./internal/handle-insert-between";
import { handleDepsMove } from "./internal/handle-deps-move";
import { repoInfoServed } from "./internal/repo-info";
import {
  autoStartReconcileWarmup,
  startRelaunchOnClaudeReady,
  stopRelaunchOnClaudeReady,
} from "./internal/auto-start-reconcile";
import { addTaskTool } from "./internal/mcp-tools";
import {
  listTasks,
  createTask,
  createTaskChain,
  insertTaskBetween,
  getTask,
  updateTask,
  moveTask,
  setTaskAutoStart,
  clearTaskAutoStart,
  addTaskDependency,
  removeTaskDependency,
  moveTaskInDepsTree,
} from "../core/endpoints";

export { armTaskAutoStart } from "./internal/arm-auto-start";

export default {
  description: "Nested tasks with attempts linking to conversations.",
  contributions: [...repoInfoServed.declare],
  httpRoutes: {
    [listTasks.route]: handleList,
    [createTask.route]: handleCreate,
    [createTaskChain.route]: handleCreateChain,
    [insertTaskBetween.route]: handleInsertBetween,
    [getTask.route]: handleGet,
    [updateTask.route]: handleUpdate,
    [moveTask.route]: handleMove,
    [setTaskAutoStart.route]: handleSetAutoStart,
    [clearTaskAutoStart.route]: handleClearAutoStart,
    [addTaskDependency.route]: handleAddDependency,
    [removeTaskDependency.route]: handleRemoveDependency,
    [moveTaskInDepsTree.route]: handleDepsMove,
  },
  register: [addTaskTool, autoStartReconcileWarmup],
  onReady: () => {
    startRelaunchOnClaudeReady();
  },
  onShutdown: () => {
    stopRelaunchOnClaudeReady();
  },
  // The `pushes` ledger used to be filled from here, by a `tasks.push-ingest`
  // job hung off the `git.refAdvanced` trigger plus a host-scoped boot warm-up.
  // Both are gone: the ledger is a projection of `main` owned by `tasks-core`,
  // refreshed by an in-process ref reaction and guaranteed on read. See
  // `research/2026-08-18-global-push-ledger-git-projection.md`.
} satisfies ServerPluginDefinition;
