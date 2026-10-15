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
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive, type LiveRowResult } from "@plugins/network/plugins/live/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useServerHealth,
  type ServerHealthRow,
} from "@plugins/apps/plugins/deploy/plugins/health/web";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import {
  deployments,
  deployRuns,
  type Deployment,
  type DeployRun,
} from "../../core";
import { RUN_STATE_OPTIONS, runStateOf } from "../internal/deploy-runs";
import { deploymentDetailPane } from "../panes";
import { DeploymentItemActions } from "./deployment-item-actions";
import { AddDeploymentDialog } from "./add-deployment-dialog";
import { RunCell, RunFailureNotice } from "./run-cell";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

const DEPLOYMENTS_VIEW = defineDataView("deploy.deployments");

// Every field the list shows is its own (the composition, the last run) or
// contributed; the collection lists only `serverId`, the scope this section
// reads by — not a column of it.
const DEPLOYMENT_OVERRIDES = fieldOverrides(deployments, {
  serverId: { visible: false, filterable: false, groupable: false },
});

/**
 * The Deployments section of a server's page: which compositions this server
 * serves, and the two verbs over each.
 *
 * A deployment is `(composition × server) → { hostnames, loopbackPort }`, so on
 * this pane the server half is fixed and only the composition and its URL vary.
 * The row carries only what a person scans down the list — the composition, the
 * last run, and (contributed) the release state; the record's editable fields and
 * the derived install names live in the row's own pane, one click away.
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
 * There is deliberately no log panel here any more. The deployment pane's Output
 * section subscribes to the same `deploy` channel, and a second live
 * subscription to one channel — under a heading, on a page that no longer hosts
 * the actions — was duplication rather than a view. Nothing is lost: the channel
 * replays its ring buffer on subscribe, so the pane shows the last run's tail on
 * open, and `RunFailureNotice` still surfaces a failed run here with the CLI's
 * own words.
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
  });
  const health = useServerHealth(serverId);

  return (
    // Nothing about the rail here: `detail-sections` opens the region on every
    // section's card body, generically, so a DataView dropped into one is
    // correctly inset with zero per-section code.
    <Stack gap="md">
      <PlatformCaption health={health} />
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
            readiness={loaded}
          />
        ),
        error: () => (
          <DeploymentsBody
            serverId={serverId}
            rows={[]}
            runs={{}}
            readiness={loaded}
          />
        ),
        ready: ({ rows, runs }) => (
          <DeploymentsBody
            serverId={serverId}
            rows={rows}
            runs={runs}
            readiness={loaded}
          />
        ),
      })}
    </Stack>
  );
}

/**
 * Which bundles this server takes, as its last probe found. Loading while the
 * verdict loads — "no verified platform yet" is a claim about the server, and
 * a read still in flight cannot make it.
 */
function PlatformCaption({
  health,
}: {
  health: LiveRowResult<ServerHealthRow>;
}): ReactNode {
  if (health.status === "loading") return <Loading />;
  if (health.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the server's platform"
        error={health.error}
        refetch={health.refetch}
      />
    );
  }
  const platform = health.found && health.row.ok ? health.row.platform : null;
  return (
    <Text as="p" variant="caption" tone="muted">
      {platform
        ? `This server accepts ${platform} bundles.`
        : "This server has no verified platform yet — run Verify connection above; the platform a deploy needs is discovered by that probe."}
    </Text>
  );
}

function DeploymentsBody({
  serverId,
  rows,
  runs,
  readiness,
}: {
  serverId: string;
  rows: readonly Deployment[];
  runs: Record<string, DeployRun>;
  readiness: ResourceReadiness;
}): ReactNode {
  const openPane = useOpenPane();
  // The selection is the ROUTE, never local state: the highlighted row and the
  // open column are then the same fact, and a deep link paints correctly.
  const selectedId = deploymentDetailPane.useRouteEntry()?.params.deploymentId;

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
        id: "run",
        label: "Last run",
        type: "enum",
        options: RUN_STATE_OPTIONS,
        value: (d) => runStateOf(runs[d.id]),
        cell: (d) => <RunCell run={runs[d.id]} />,
        // Trailing, so the list row keeps it out of the truncating subtitle line.
        align: "end",
      },
      // The `release` column is NOT here: it is a client field of the
      // `deployments` collection (`releaseFields`), declared and resolved by
      // whichever plugin owns the release pipeline, so this list never names
      // that feature.
    ],
    [runs],
  );

  const creators: CreateOption[] = [
    {
      id: "add",
      label: "Add deployment",
      icon: <Icon icon={addIcon} />,
      onSelect: () => {
        // Fire-and-forget: awaiting `openDialog` would hold the toolbar's busy
        // flag for the dialog's whole open lifetime.
        void openDialog(
          (close) => (
            <AddDeploymentDialog
              serverId={serverId}
              existing={rows}
              close={close}
            />
          ),
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
        rowActivation={(d) =>
          openPane.to(
            deploymentDetailPane,
            { serverId, deploymentId: d.id },
            { mode: "push", side: "right" },
          )
        }
        emptyState="Nothing is deployed on this server yet."
      />
    </>
  );
}
