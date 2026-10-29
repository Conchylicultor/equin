import type { ReactElement } from "react";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  deployRunHistory,
  deployments,
  runDeployment,
  type Deployment,
  type DeployRunRecord,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { useBlockedReason } from "@plugins/apps/plugins/deploy/plugins/deployments/web";

const rollbackIcon = symbol("history");
const LABEL = "Roll back to this run";

/**
 * Roll back to a succeeded run: ship its pinned release bundle again
 * (`{ verb: "ship", release }`), behind the CLI's remote health gate like any
 * ship. No converge and no build — the bytes already exist, and a rollback that
 * rebuilt would not be one.
 *
 * Rendered on succeeded runs only. Disabled, with the reason as the tooltip,
 * when the run pinned no release (a converge, or a bare ship that let the CLI
 * pick `latest-<platform>` — this app never learned which bundle), and when it
 * is the run live now. Every other refusal is the CLI's: a bundle pruned since
 * fails the new run with `no-such-run`, verbatim, on its History row.
 */
export function RollbackAction({
  row,
}: ItemActionProps<DeployRunRecord>): ReactElement | null {
  if (row.status !== "succeeded") return null;
  if (row.releaseRunId === null) {
    return (
      <IconButton
        icon={rollbackIcon}
        label={LABEL}
        tooltip="This run pinned no release bundle, so there is nothing to ship again."
        disabled
      />
    );
  }
  return <PinnedRollback row={row} release={row.releaseRunId} />;
}

/**
 * Split out so the live reads happen only for a run that could be rolled back
 * to — a hook cannot be called after an early return.
 */
function PinnedRollback({
  row,
  release,
}: {
  row: DeployRunRecord;
  release: string;
}): ReactElement {
  const deployment = useLiveRow(deployments, row.deploymentId);
  if (deployment.status === "loading") {
    return <Blocked reason="Loading the deployment…" />;
  }
  if (deployment.status === "error") {
    return (
      <Blocked
        reason={`Couldn't load the deployment: ${deployment.error.message}`}
      />
    );
  }
  if (!deployment.found) {
    return <Blocked reason="This run's deployment no longer exists." />;
  }
  return (
    <RollbackButton row={row} release={release} deployment={deployment.row} />
  );
}

function RollbackButton({
  row,
  release,
  deployment,
}: {
  row: DeployRunRecord;
  release: string;
  deployment: Deployment;
}): ReactElement {
  const blocked = useBlockedReason(deployment);
  const live = useLive(deployRunHistory, {
    where: {
      deploymentId: row.deploymentId,
      status: "succeeded",
      verb: { in: ["ship", "update"] },
    },
    orderBy: [["startedAt", "desc"]],
    limit: 1,
  });
  const run = useEndpointMutation(runDeployment);

  // Never offered on a guess: until the newest ship is known, this row may be it.
  const reason =
    live.status === "loading"
      ? "Loading which run is live…"
      : live.status === "error"
        ? `Couldn't load which run is live: ${live.error.message}`
        : live.data[0]?.id === row.id
          ? "This is the run live on the server now."
          : blocked;

  if (reason !== null) return <Blocked reason={reason} />;
  const commit = row.commitSha ? ` (${row.commitSha.slice(0, 7)})` : "";
  return (
    <IconButton
      icon={rollbackIcon}
      label={LABEL}
      tooltip={`Ship release ${release}${commit} to this server again`}
      disabled={run.isPending}
      onClick={(e) => {
        e.stopPropagation();
        void confirmDialog({
          title: `Roll ${row.compositionId} back to this run?`,
          description: `This ships release ${release}${commit} to the server again, replacing what is live now. It goes through the same health gate as any ship.`,
          confirmLabel: "Roll back",
          onConfirm: () =>
            run.mutateAsync({
              params: { id: row.deploymentId },
              body: { verb: "ship", release },
            }),
        });
      }}
    />
  );
}

function Blocked({ reason }: { reason: string }): ReactElement {
  return (
    <IconButton icon={rollbackIcon} label={LABEL} tooltip={reason} disabled />
  );
}
