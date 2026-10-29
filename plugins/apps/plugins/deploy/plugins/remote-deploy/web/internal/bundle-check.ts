import { useLive } from "@plugins/network/plugins/live/web";
import type {
  SiteCheckResult,
  SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { runningCommit, shortSha } from "../../core";

/**
 * Bundle up to date: whether what the box runs contains every commit on `main`
 * (the same `runningCommit` the Bundle cell and the behind-main banner read).
 * Shipping fixes it, so there is no Fix link: the header's Deploy button is
 * the fix.
 */
export function useBundleCheck({ deployment }: SiteProps): SiteCheckResult {
  const commit = useLive(runningCommit, { deploymentId: deployment.id });
  const label = "Bundle up to date";
  if (commit.status === "loading") {
    return { state: "pending", label, detail: "Checking…" };
  }
  if (commit.status === "error") {
    return {
      state: "fail",
      label,
      detail: `Couldn't read the running commit: ${commit.error.message}`,
    };
  }
  if (commit.data.kind === "unknown") {
    return { state: "warn", label, detail: commit.data.reason };
  }
  const { behindMain, sha } = commit.data;
  return behindMain > 0
    ? {
        state: "warn",
        label,
        detail: `${behindMain} commit${behindMain === 1 ? "" : "s"} behind main`,
      }
    : {
        state: "ok",
        label,
        detail: `Running ${shortSha(sha)}, up to date with main`,
      };
}
