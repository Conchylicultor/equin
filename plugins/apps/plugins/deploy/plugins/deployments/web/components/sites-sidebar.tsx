import type { ReactElement, ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  matchResource,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { SidebarPaneSection } from "@plugins/primitives/plugins/app-shell/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { deployments, type Deployment } from "../../core";
import { sitePane } from "../panes";
import { AddDeploymentDialog } from "./add-deployment-dialog";
import { useSiteStatuses, type SiteStatusOf } from "../internal/site-status";
import { SiteStatusMark } from "./site-status-dot";

const sitesIcon = symbol("language");
const addIcon = symbol("add");

/**
 * The sidebar's Sites section: every site, its status dot, the open one
 * marked; "+" adds one (the add dialog, picking its server). The rows and
 * every status are read once and gated together (`useSiteStatuses`), never a
 * read per row.
 */
export function SitesSidebarSection(): ReactElement {
  const result = useCombinedResources({
    rows: useLive(deployments),
    statusOf: useSiteStatuses(),
  });
  return (
    <SidebarPaneSection icon={sitesIcon} title="Sites" labelExtra={AddSite}>
      {matchResource(result, {
        loading: () => <Loading variant="rows" />,
        ready: ({ rows, statusOf }) => (
          <SiteRows rows={rows} statusOf={statusOf} />
        ),
      })}
    </SidebarPaneSection>
  );
}

function AddSite(): ReactElement {
  return (
    <IconButton
      icon={addIcon}
      label="New site"
      glyph="small"
      onClick={(e) => {
        // The "+" sits inside the section's fold trigger: adding a site must
        // not also fold the list.
        e.stopPropagation();
        void openDialog((close) => <AddDeploymentDialog close={close} />, {
          size: "md",
        });
      }}
    />
  );
}

function SiteRows({
  rows,
  statusOf,
}: {
  rows: readonly Deployment[];
  statusOf: SiteStatusOf;
}): ReactNode {
  const openPane = useOpenPane();
  // The selection is the ROUTE: the marked row and the page on screen are one
  // fact, and a deep link marks correctly.
  const openId = sitePane.useRouteEntry()?.params.deploymentId;
  if (rows.length === 0) {
    return (
      <Text as="p" variant="caption" tone="muted">
        No sites yet.
      </Text>
    );
  }
  return (
    <SidebarMenu>
      {rows.map((d) => (
        <SidebarMenuItem key={d.id}>
          <SidebarMenuButton
            isActive={d.id === openId}
            {...openPane.link(
              sitePane,
              { deploymentId: d.id },
              { mode: "root" },
            )}
          >
            <SiteStatusMark status={statusOf(d.id)} />
            <span>{d.hostnames[0] ?? d.compositionId}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
