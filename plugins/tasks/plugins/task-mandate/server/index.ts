import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { putTaskMandate } from "../core";
import { handlePutTaskMandate } from "./internal/routes";

export default {
  description:
    "The endpoint that states a named mandate as a task's own (PUT /api/tasks/:taskId/mandate), refusing an id no definition names.",
  httpRoutes: {
    [putTaskMandate.route]: handlePutTaskMandate,
  },
} satisfies ServerPluginDefinition;
