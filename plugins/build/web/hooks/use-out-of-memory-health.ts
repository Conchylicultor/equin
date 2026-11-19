import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/core";
import { buildHistory } from "../../core";
import { outOfMemoryHealth } from "../internal/out-of-memory-health";

/**
 * The "Update not deployed" row's `useStatus`: `outOfMemoryHealth` over the
 * build history's default window — boot-preloaded, and the same window the
 * Build button reads, so the always-on probe opens no read of its own. Not
 * known yet is `unknown`, never `absent`: the row must not claim there is
 * nothing to say before the history says so.
 */
export function useOutOfMemoryHealth(): HealthStatus {
  const history = useLive(buildHistory);
  switch (history.status) {
    case "loading":
      return { state: "unknown" };
    case "error":
      return {
        state: "unknown",
        summary: "Couldn't read the build history",
      };
    case "ready":
      return outOfMemoryHealth(history.data);
  }
}
