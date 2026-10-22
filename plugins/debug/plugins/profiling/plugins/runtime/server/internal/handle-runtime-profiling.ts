import {
  getRuntimeProfile as getProfileData,
  resetRuntimeProfile as doReset,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  getRuntimeProfile as getRuntimeProfileEndpoint,
  resetRuntimeProfile as resetRuntimeProfileEndpoint,
} from "../../core";
import { runtimeProfile } from "../../shared/resources";

function measureRuntimeProfile() {
  const profile = getProfileData();
  // sinceMs is the profiler's performance.now() at window start; the elapsed
  // window is now − sinceMs on the same monotonic clock. Computed here so the
  // client renders the true "since boot" duration instead of the raw offset.
  return { ...profile, windowMs: performance.now() - profile.sinceMs };
}

// Kept for the get_runtime_profile MCP tool, which reads another worktree's
// backend over HTTP (`mcp-tools.ts`); the pane reads the live value below.
export const handleRuntimeProfiling = implement(
  getRuntimeProfileEndpoint,
  measureRuntimeProfile,
);

export const runtimeProfileServed = serveValue(runtimeProfile, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "a point-in-time read of this process's in-memory span recorder, which moves on every span; re-measured on refresh()",
    },
  },
  loader: measureRuntimeProfile,
});

export const handleResetRuntimeProfiling = implement(
  resetRuntimeProfileEndpoint,
  () => {
    doReset();
  },
);
