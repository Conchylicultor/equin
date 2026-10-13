import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleStart } from "./internal/handle-start";
import { handleStop } from "./internal/handle-stop";
import { handleStatus } from "./internal/handle-status";
import { stopEmitting } from "./internal/emitter";
import { emitStatusServed } from "./internal/status-value";
import { startEmit, stopEmit, getEmitStatus } from "../shared/endpoints";

export default {
  description:
    "Synthetic no-op live-state push emitter: drives N triggerResourcePush calls/sec for a chosen resource on a bounded setInterval (hard auto-stop cap), so churn-driven render/DOM bugs reproduce deterministically. Surfaced as the Debug → Live-State Emit pane. Its status is the live-state-emit.status value, notified by the emitter on every change; the resource dropdown reads debug/read-set's resources.debug snapshot.",
  httpRoutes: {
    [startEmit.route]: handleStart,
    [stopEmit.route]: handleStop,
    [getEmitStatus.route]: handleStatus,
  },
  contributions: [...emitStatusServed.declare],
  onShutdown: () => {
    stopEmitting();
  },
} satisfies ServerPluginDefinition;
