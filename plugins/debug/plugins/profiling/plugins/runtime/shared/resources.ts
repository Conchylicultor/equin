import { liveValue } from "@plugins/network/plugins/live/core";
import { runtimeProfileSchema } from "./endpoints";

/**
 * This backend's in-memory runtime profile (the recorder's
 * `getRuntimeProfile()` plus the elapsed window), measured when a reader asks —
 * on mount, on the section's Refresh, and after Reset window (`refresh()`).
 */
export const runtimeProfile = liveValue("runtime-profiler.profile", {
  schema: runtimeProfileSchema,
  load: "snapshot",
});
