import { useLive } from "@plugins/network/plugins/live/web";
import {
  DeploymentDetail,
  useSiteTabLink,
  type SiteCheckResult,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import {
  DEPLOY_SECRET_STATUS_LABELS,
  deploySecretsStatus,
  SECRETS_SECTION_ID,
} from "../../core";

/**
 * Secrets approved: how many of the deploy secrets this site's composition
 * needs are approved for its server. Absent when it needs none. The Fix link
 * opens the Settings tab (and reveals the Secrets section).
 */
export function useSecretsCheck({
  deployment,
}: SiteProps): SiteCheckResult | null {
  const result = useLive(deploySecretsStatus, { deploymentId: deployment.id });
  const settings = useSiteTabLink("settings");
  const reveal = DeploymentDetail.useRevealSection();
  const label = "Secrets approved";
  if (result.status === "loading") {
    return { state: "pending", label, detail: "Checking…" };
  }
  if (result.status === "error") {
    return {
      state: "fail",
      label,
      detail: `Couldn't read the deploy secrets: ${result.error.message}`,
    };
  }
  const rows = result.data;
  if (rows.length === 0) return null;
  const waiting = rows.filter((r) => r.status !== "approved");
  const first = waiting[0];
  if (!first) {
    return {
      state: "ok",
      label,
      detail: `${rows.length} of ${rows.length} approved`,
    };
  }
  return {
    state: "warn",
    label,
    detail:
      waiting.length === 1
        ? `${first.key} ${DEPLOY_SECRET_STATUS_LABELS[first.status]}`
        : `${rows.length - waiting.length} of ${rows.length} approved`,
    fix: {
      open: () => {
        settings.open();
        reveal(SECRETS_SECTION_ID);
      },
      href: settings.href,
    },
  };
}
