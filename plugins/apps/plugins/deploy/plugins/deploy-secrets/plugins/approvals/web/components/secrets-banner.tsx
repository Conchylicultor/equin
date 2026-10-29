import type { ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DeploymentDetail,
  useSetSiteTab,
  type SiteBannerAnswer,
  type SiteBannerSpec,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  DEPLOY_SECRET_STATUS_LABELS,
  deploySecretsStatus,
  SECRETS_SECTION_ID,
  type DeploySecretRow,
} from "../../core";

const keyIcon = symbol("key");

/**
 * The site page's "needs approval" banner: a deploy secret the composition
 * needs that the user has not approved for this deployment — the next deploy
 * would be held on it. Names the key(s) and links to the Secrets section.
 */
export function useSecretsBanner({ deployment }: SiteProps): SiteBannerAnswer {
  const result = useLive(deploySecretsStatus, { deploymentId: deployment.id });
  return foldResource(result, {
    // Not known yet: hold the chain so no lower banner flashes first.
    loading: (): SiteBannerAnswer => "pending",
    error: (error) => ({
      tone: "destructive",
      icon: keyIcon,
      title: "Couldn't read this site's deploy secrets",
      body: error.message,
    }),
    ready: (rows) => waitingSpec(rows),
  });
}

function waitingSpec(rows: readonly DeploySecretRow[]): SiteBannerSpec | null {
  const waiting = rows.filter((r) => r.status !== "approved");
  const first = waiting[0];
  if (!first) return null;
  return {
    tone: "warning",
    icon: keyIcon,
    title:
      waiting.length === 1
        ? `${first.key} ${DEPLOY_SECRET_STATUS_LABELS[first.status]}.`
        : `${waiting.length} secrets wait on you.`,
    body: "The next deploy waits until you approve it for this server.",
    actions: <ReviewSecret rows={waiting} />,
  };
}

function ReviewSecret({
  rows,
}: {
  rows: readonly DeploySecretRow[];
}): ReactNode {
  const setTab = useSetSiteTab();
  const reveal = DeploymentDetail.useRevealSection();
  return (
    <Button
      variant="outline"
      onClick={() => {
        setTab("settings");
        reveal(SECRETS_SECTION_ID);
      }}
    >
      {rows.length === 1 ? "Review secret" : "Review secrets"}
    </Button>
  );
}
