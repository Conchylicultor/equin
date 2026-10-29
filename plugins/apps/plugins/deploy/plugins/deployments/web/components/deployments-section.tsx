import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  type CreateOption,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  matchResource,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import {
  deployments,
  deployRuns,
  type Deployment,
  type DeployRun,
} from "../../core";
import { useSiteStatuses, type SiteStatusOf } from "../internal/site-status";
import { sitePane } from "../panes";
import { DeploymentItemActions } from "./deployment-item-actions";
import { AddDeploymentDialog } from "./add-deployment-dialog";
import { RunFailureNotice } from "./run-cell";
import { SITE_STATUS_OPTIONS, SiteStatusPill } from "./site-status-dot";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

/** The not-yet-loaded body renders no rows, so no status is ever asked. */
const NO_STATUS: SiteStatusOf = (id) => {
  throw new Error(`site status read before the run map loaded: ${id}`);
};

const DEPLOYMENTS_VIEW = defineDataView("deploy.deployments");

// Every field the list shows is its own (the composition, the last run) or
// contributed; the collection lists only `serverId`, the scope this section
// reads by — not a column of it.
const DEPLOYMENT_OVERRIDES = fieldOverrides(deployments, {
  serverId: { visible: false, filterable: false, groupable: false },
});

/**
 * The "Sites on this server" section of a server's page: which compositions
 * this server serves — each row a site, opening its page — and its status.
 *
 * A deployment is `(composition × server) → { hostnames, loopbackPort }`, so on
 * this pane the server half is fixed and only the composition and its URL vary.
 * The row carries only what a person scans down the list — the composition, the
 * last run, and (contributed) the release state; the record's editable fields and
 * the derived install names live on the site's own page, one click away.
 *
 * The list reads this server's rows of the `deployments` collection (`where:
 * { serverId }`), and it is gated together with the run map
 * (`useCombinedResources`), so the list and the run chips can never render from
 * a half-loaded snapshot — a deployment showing "not run" only because the run
 * map had not arrived would be exactly the wrong-state-while-loading bug.
 *
 * Contributed as a `ServerDetail` section, so the card, its "Deployments" title
 * and its collapse state all belong to the host.
 *
 * There is deliberately no log panel here. The site page's deploying banner
 * subscribes to the `deploy` channel, and a second live subscription to one
 * channel — on a page that does not host the actions — would be duplication
 * rather than a view. `RunFailureNotice` still surfaces a failed run here with
 * the CLI's own words.
 */
export function DeploymentsSection({
  server,
}: {
  server: Server;
}): ReactElement {
  const serverId = server.id;
  const loaded = useCombinedResources({
    rows: useLive(deployments, { where: { serverId } }),
    runs: useLive(deployRuns),
    statusOf: useSiteStatuses(),
  });

  return (
    // Nothing about the rail here: `detail-sections` opens the region on every
    // section's card body, generically, so a DataView dropped into one is
    // correctly inset with zero per-section code.
    <>
      {matchResource(loaded, {
        // The DataView owns the loading and error renders (its own skeleton,
        // the failure with Retry) and keeps its chrome stable, so the "nothing
        // is deployed" empty state always means confirmed-empty. Same shape as
        // the servers list next door.
        loading: () => (
          <DeploymentsBody
            serverId={serverId}
            rows={[]}
            runs={{}}
            statusOf={NO_STATUS}
            readiness={loaded}
          />
        ),
        error: () => (
          <DeploymentsBody
            serverId={serverId}
            rows={[]}
            runs={{}}
            statusOf={NO_STATUS}
            readiness={loaded}
          />
        ),
        ready: ({ rows, runs, statusOf }) => (
          <DeploymentsBody
            serverId={serverId}
            rows={rows}
            runs={runs}
            statusOf={statusOf}
            readiness={loaded}
          />
        ),
      })}
    </>
  );
}

function DeploymentsBody({
  serverId,
  rows,
  runs,
  statusOf,
  readiness,
}: {
  serverId: string;
  rows: readonly Deployment[];
  runs: Record<string, DeployRun>;
  statusOf: SiteStatusOf;
  readiness: ResourceReadiness;
}): ReactNode {
  const openPane = useOpenPane();
  // The selection is the ROUTE, never local state: the highlighted row and the
  // open column are then the same fact, and a deep link paints correctly.
  const selectedId = sitePane.useRouteEntry()?.params.deploymentId;

  const extraFields = useMemo<FieldDef<Deployment>[]>(
    () => [
      // Carried, not derived: the field id a saved view names is `composition`.
      {
        id: "composition",
        label: "Composition",
        type: "text",
        primary: true,
        value: (d) => d.compositionId,
      },
      {
        id: "status",
        label: "Status",
        type: "enum",
        options: SITE_STATUS_OPTIONS,
        value: (d) => statusOf(d.id),
        cell: (d) => <SiteStatusPill status={statusOf(d.id)} />,
      },
      {
        id: "commit",
        label: "Commit",
        type: "text",
        value: (d) => runs[d.id]?.commitSha?.slice(0, 7) ?? "",
      },
      // The `release` column is NOT here: it is a client field of the
      // `deployments` collection (`releaseFields`), declared and resolved by
      // whichever plugin owns the release pipeline, so this list never names
      // that feature.
    ],
    [runs, statusOf],
  );

  const creators: CreateOption[] = [
    {
      id: "add",
      label: "Deploy a composition",
      icon: <Icon icon={addIcon} />,
      onSelect: () => {
        // Fire-and-forget: awaiting `openDialog` would hold the toolbar's busy
        // flag for the dialog's whole open lifetime.
        void openDialog(
          (close) => <AddDeploymentDialog serverId={serverId} close={close} />,
          { size: "md" },
        );
      },
    },
  ];

  return (
    <>
      <RunFailureNotice
        runs={Object.values(runs).filter((r) => r.serverId === serverId)}
      />
      <DataView<Deployment>
        rows={rows}
        collection={deployments}
        overrides={DEPLOYMENT_OVERRIDES}
        extraFields={extraFields}
        rowKey={(d) => d.id}
        views={["list", "table"]}
        defaultView="list"
        storageKey={DEPLOYMENTS_VIEW}
        readiness={readiness}
        itemActions={DeploymentItemActions}
        creators={creators}
        selectedRowId={selectedId}
        // A site is a page of its own, not a drill-in under its server: the
        // row opens it as the route root, as the sidebar's Sites row does.
        rowActivation={(d) =>
          openPane.to(sitePane, { deploymentId: d.id }, { mode: "root" })
        }
        emptyState="No sites on this server yet."
      />
    </>
  );
}
