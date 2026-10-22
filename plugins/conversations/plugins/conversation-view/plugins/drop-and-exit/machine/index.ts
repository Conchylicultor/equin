import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleDropAndExit } from "./internal/handle-drop-and-exit";
import { dropAndExit } from "../core/endpoints";

export default {
  description:
    "Drop & Close, desktop-only half: the drop-and-exit endpoint (needsMachine) — drops the task unless its work landed, closes the conversation and stops its agent.",
  httpRoutes: {
    [dropAndExit.route]: handleDropAndExit,
  },
} satisfies MachinePluginDefinition;
