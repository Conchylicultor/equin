import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deleteTaskMandate, putTaskMandate } from "../core";
import {
  handleDeleteTaskMandate,
  handlePutTaskMandate,
} from "./internal/routes";

export default {
  description:
    "The endpoints that change a task's mandate: PUT /api/tasks/:taskId/mandate states a named mandate as the task's own (refusing an id no definition names), DELETE drops it so the task inherits its nearest ancestor's again (refused on a root).",
  httpRoutes: {
    [putTaskMandate.route]: handlePutTaskMandate,
    [deleteTaskMandate.route]: handleDeleteTaskMandate,
  },
} satisfies ServerPluginDefinition;
