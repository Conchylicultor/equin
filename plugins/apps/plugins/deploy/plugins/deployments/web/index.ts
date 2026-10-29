import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ServerDetail } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DeploymentsSection } from "./components/deployments-section";
import {
  DeploymentGeneral,
  DeploymentInstall,
} from "./components/deployment-overview";
import { DangerZone, SiteSettingsTab } from "./components/site-settings";
import { SiteOverviewTab } from "./components/site-overview";
import { ServerCell } from "./components/server-cell";
import { useServerCheck } from "./internal/server-check";
import {
  DeploymentItemActions,
  DeployAction,
  DeleteDeploymentAction,
} from "./components/deployment-item-actions";
import { legacyDeploymentPane, sitePane, sitesIndexPane } from "./panes";
import { SitesSidebarSection } from "./components/sites-sidebar";
import { Deploy } from "@plugins/apps/plugins/deploy/plugins/shell/web";
import { opensPane } from "@plugins/primitives/plugins/app-shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  DeploymentDetail,
  SiteBanner,
  SiteCheck,
  SiteHeader,
  SiteOverview,
  SiteStrip,
  SiteTabs,
} from "./slots";
import { IdKinds } from "@plugins/ids/web";
import { deploymentIdKind, deployRunIdKind } from "../core";

export {
  DeploymentItemActions,
  useBlockedReason,
} from "./components/deployment-item-actions";
export {
  DeploymentDetail,
  SiteBanner,
  SiteCheck,
  SiteHeader,
  SiteOverview,
  SiteStrip,
  SiteTabs,
} from "./slots";
export type {
  SiteBannerAnswer,
  SiteBannerSpec,
  SiteCheckResult,
  SiteProps,
} from "./slots";
export {
  SiteCard,
  SiteCardBody,
  SITE_CARD_LIST_TOOLBAR,
} from "./components/site-card";
export { useSetSiteTab, useSiteTabLink } from "./internal/site-tab";
export { ApprovalLinks } from "./components/approval-links";
export { sitePane, sitesIndexPane } from "./panes";
export { useSiteStatus } from "./internal/site-status";
export type { SiteStatus } from "./internal/site-status";

export default {
  description:
    "Sites — the Deploy app's primary entity, a deployment: the sites index (the app's landing page, a DataView of every deployment with its server and status), the site page (site/:deploymentId/:tab?) — a header (mark, hostname, status pill, hostnames, composition, contributed SiteHeader actions), the production strip (SiteStrip cells, its Server cell this plugin's own) with the first applicable SiteBanner, and the SiteTabs host bound to the URL's :tab?, whose Overview (a two-column host over SiteOverview.Card plus a Checks card over SiteCheck) and Settings (the DeploymentDetail sections — General, Install and a Danger zone of its own — under a left anchor rail) tabs are this plugin's, the sidebar's Overview entry and Sites section (status dot per site from useSiteStatus, + opening the add dialog), and the Deployments section of a server's page (that server's sites as a DataView, an add affordance whose composition picker reads the compositions config, a Deploy row action that launches the CLI's whole converge-build-ship run). Old server/:serverId/dep/:deploymentId links forward to the site.",
  contributions: [
    IdKinds.Kind({ kind: deploymentIdKind }),
    IdKinds.Kind({ kind: deployRunIdKind }),
    ServerDetail.Section({
      id: "deployments",
      label: "Sites on this server",
      column: "main",
      component: DeploymentsSection,
      useDefaultOpen: () => true,
    }),
    Pane.Register({ pane: sitesIndexPane }),
    Pane.Register({ pane: sitePane }),
    // Old `server/<id>/dep/<id>` links forward to the site (replace-navigate).
    Pane.Register({ pane: legacyDeploymentPane }),
    Deploy.Sidebar({
      id: "overview",
      title: "Overview",
      icon: symbol("space-dashboard"),
      opens: opensPane(sitesIndexPane, {}),
    }),
    Deploy.Sidebar({
      id: "sites",
      title: "Sites",
      icon: symbol("language"),
      component: SitesSidebarSection,
    }),
    // The site page's own tabs — Overview (a grid over SiteOverview.Card and
    // SiteCheck) and Settings (the DeploymentDetail sections) — contributed
    // through the same slot as every other tab: the page's owner gets no
    // privileged mount point.
    SiteTabs.View({
      id: "overview",
      title: "Overview",
      icon: symbol("space-dashboard"),
      component: SiteOverviewTab,
    }),
    SiteTabs.View({
      id: "settings",
      title: "Settings",
      icon: symbol("settings"),
      component: SiteSettingsTab,
    }),
    SiteStrip.Cell({ id: "server", label: "Server", component: ServerCell }),
    SiteCheck({ id: "server", useCheck: useServerCheck }),
    // Settings: the record, its derived install, and removing it — every
    // section open, a page read top to bottom.
    DeploymentDetail.Section({
      id: "overview",
      label: "General",
      component: DeploymentGeneral,
      useDefaultOpen: () => true,
    }),
    DeploymentDetail.Section({
      id: "install",
      label: "Install",
      component: DeploymentInstall,
      useDefaultOpen: () => true,
    }),
    DeploymentDetail.Section({
      id: "danger",
      label: "Danger zone",
      component: DangerZone,
      useDefaultOpen: () => true,
    }),
    // Deploy and Delete are contributed into this plugin's own row-action slot
    // rather than hard-rendered, so the row's affordances stay a set the reorder
    // config orders and a later plugin can extend (a rollback action, say)
    // without touching the list.
    DeploymentItemActions({ id: "deploy", component: DeployAction }),
    DeploymentItemActions({ id: "delete", component: DeleteDeploymentAction }),
  ],
  slots: {
    ...DeploymentDetail,
    siteTabs: SiteTabs.View,
    siteHeaderActions: SiteHeader.Action,
    siteStrip: SiteStrip.Cell,
    siteBanner: SiteBanner,
    siteOverview: SiteOverview.Card,
    siteChecks: SiteCheck,
    itemActions: DeploymentItemActions,
    "deploy-index": sitesIndexPane,
    "deploy-site": sitePane,
    "deploy-deployment-detail": legacyDeploymentPane,
  },
} satisfies PluginDefinition;
