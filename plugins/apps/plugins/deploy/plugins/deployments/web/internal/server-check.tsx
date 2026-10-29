import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { serverDetailPane } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { useServerHealth } from "@plugins/apps/plugins/deploy/plugins/health/web";
import type { SiteCheckResult, SiteProps } from "../slots";

/**
 * Server reachable: the last SSH probe of the server this site runs on. This
 * plugin's own check (not `health`'s): `deployments` already reads `health`, so
 * `health` contributing here would close a cycle. A failed read is a failed
 * check carrying the read's message — never "ok" and never silence.
 */
export function useServerCheck({ deployment }: SiteProps): SiteCheckResult {
  const health = useServerHealth(deployment.serverId);
  const openPane = useOpenPane();
  const label = "Server reachable";
  const fix = openPane.to(
    serverDetailPane,
    { serverId: deployment.serverId },
    { mode: "root" },
  );
  if (health.status === "loading") {
    return { state: "pending", label, detail: "Checking…" };
  }
  if (health.status === "error") {
    return {
      state: "fail",
      label,
      detail: `Couldn't read the server's health: ${health.error.message}`,
    };
  }
  if (!health.found) {
    return {
      state: "warn",
      label,
      detail: "This server has never been checked.",
      fix,
    };
  }
  const row = health.row;
  if (!row.ok) {
    return {
      state: "fail",
      label,
      detail: row.failureMessage ?? "The last SSH check failed.",
      fix,
    };
  }
  return {
    state: "ok",
    label,
    detail: (
      <>
        SSH verified · checked <RelativeTime date={row.checkedAt} />
      </>
    ),
  };
}
