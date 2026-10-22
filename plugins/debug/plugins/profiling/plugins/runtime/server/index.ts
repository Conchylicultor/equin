import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  handleRuntimeProfiling,
  handleResetRuntimeProfiling,
  runtimeProfileServed,
} from "./internal/handle-runtime-profiling";
import { handleFlightWindow } from "./internal/handle-flight-window";
import { runtimeProfileTool } from "./internal/mcp-tools";
import {
  getFlightWindow,
  getRuntimeProfile,
  resetRuntimeProfile,
} from "../core";

export default {
  description:
    "Runtime HTTP/DB/loader profiling tables in the Gantt debug pane.",
  httpRoutes: {
    [getRuntimeProfile.route]: handleRuntimeProfiling,
    [resetRuntimeProfile.route]: handleResetRuntimeProfiling,
    [getFlightWindow.route]: handleFlightWindow,
  },
  register: [runtimeProfileTool],
  contributions: [...runtimeProfileServed.declare],
} satisfies ServerPluginDefinition;
