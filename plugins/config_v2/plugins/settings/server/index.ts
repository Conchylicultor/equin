import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { setConfigField } from "@plugins/config_v2/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import {
  resetConfigField,
  acknowledgeConflict,
  deleteOverride,
  mergeConflict,
  CONFIG_CATEGORY_ID,
} from "../core";
import {
  handleSetField,
  handleResetField,
  handleAcknowledgeConflict,
  handleDeleteOverride,
  handleMergeConflict,
} from "./internal/handlers";

export default {
  description:
    "HTTP endpoints for setting and resetting config_v2 field values, and the Config task category the conflict-resolution agent files under.",
  contributions: [
    TaskCategory({ id: CONFIG_CATEGORY_ID, label: "Config", order: 10 }),
  ],
  httpRoutes: {
    [setConfigField.route]: handleSetField,
    [resetConfigField.route]: handleResetField,
    [acknowledgeConflict.route]: handleAcknowledgeConflict,
    [deleteOverride.route]: handleDeleteOverride,
    [mergeConflict.route]: handleMergeConflict,
  },
} satisfies ServerPluginDefinition;
