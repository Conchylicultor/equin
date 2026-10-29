import { useEffect, type ReactElement } from "react";
import {
  defineRoute,
  Pane,
  PaneChrome,
  resolveRow,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  deployApp,
  deployIndexRoute,
} from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { serverDetailRoute } from "@plugins/apps/plugins/deploy/plugins/servers/core";
import { deployments, siteRoute } from "../core";
import { SitePage } from "./components/site-page";
import { SitesIndex } from "./components/sites-index";

function useResolveDeployment({
  deploymentId,
}: {
  deploymentId: string;
}): ResolveResult {
  return resolveRow(useLiveRow(deployments, deploymentId));
}

/**
 * The name a person recognises a site by: its primary hostname, else (a
 * loopback-only deployment has none) its composition.
 */
function useSiteTitle({
  deploymentId,
}: {
  deploymentId: string;
}): string | undefined {
  const row = useLiveRow(deployments, deploymentId);
  // Loading or failed: no title of its own yet; the chrome's title stands in.
  if (row.status === "loading" || row.status === "error") return undefined;
  if (!row.found) return undefined;
  return row.row.hostnames[0] ?? row.row.compositionId;
}

/**
 * The app's landing page (bare `/deploy`): every site at a glance.
 */
export const sitesIndexPane = Pane.define({
  title: "Overview",
  route: deployIndexRoute,
  app: deployApp,
  appIndex: true,
  component: SitesIndexBody,
});

function SitesIndexBody(): ReactElement {
  return (
    <PaneChrome pane={sitesIndexPane}>
      <SitesIndex />
    </PaneChrome>
  );
}

/**
 * One site — the app's primary page. `:tab?` names the tab on screen (bare =
 * the first available, Overview).
 */
export const sitePane = Pane.define({
  route: siteRoute,
  app: deployApp,
  component: SiteBody,
  useResolve: useResolveDeployment,
  title: { useText: useSiteTitle, fallback: "Site" },
});

function SiteBody(): ReactElement {
  const { deploymentId } = sitePane.useParams();
  const row = useLiveRow(deployments, deploymentId);
  return (
    <PaneChrome pane={sitePane}>
      {/* `useResolve` has already gated loading / error / gone: the body only
          ever renders once the row is found. */}
      {row.status === "ready" && row.found ? (
        <SitePage deployment={row.row} />
      ) : (
        <Loading variant="rows" />
      )}
    </PaneChrome>
  );
}

/**
 * The address a deployment had before sites were pages of their own —
 * `server/<serverId>/dep/<deploymentId>` — kept so an old link (a bookmark, a
 * notification, a history entry) still lands. Declared here, beside the one
 * pane that answers it, rather than in `core/`: nothing builds this URL any
 * more. It keeps the old pane's id too: a restored tab's history entry names
 * the pane by id, so the same id forwards it rather than resolving to nothing.
 */
const legacyDeploymentRoute = defineRoute({
  id: "deploy-deployment-detail",
  segment: "dep/:deploymentId",
  parent: serverDetailRoute,
});

/**
 * Forwards an old deployment URL to its site, REPLACING the history entry —
 * Back skips the address that only ever forwarded instead of bouncing on it.
 * Resolves like the site itself, so a link to a deployment that no longer
 * exists reads as missing rather than forwarding to nothing.
 */
export const legacyDeploymentPane = Pane.define({
  route: legacyDeploymentRoute,
  app: deployApp,
  component: LegacyDeploymentBody,
  useResolve: useResolveDeployment,
  title: { useText: useSiteTitle, fallback: "Site" },
});

function LegacyDeploymentBody(): ReactElement {
  const { deploymentId } = legacyDeploymentPane.useParams();
  const openPane = useOpenPane();
  useEffect(() => {
    openPane(sitePane, { deploymentId }, { mode: "root", replace: true });
  }, [openPane, deploymentId]);
  return (
    <PaneChrome pane={legacyDeploymentPane}>
      <Loading variant="rows" />
    </PaneChrome>
  );
}
