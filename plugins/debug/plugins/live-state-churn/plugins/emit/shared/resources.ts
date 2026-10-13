import { liveValue } from "@plugins/network/plugins/live/core";
import { EmitStatusSchema } from "../core";

/**
 * The in-memory emit controller's status, pushed on every change the emitter
 * makes (start, stop, auto-stop, each tick — throttled server-side).
 */
export const liveStateEmitStatus = liveValue("live-state-emit.status", {
  schema: EmitStatusSchema,
});
