import type { ReactElement } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useLive, useLiveMutation } from "@plugins/network/plugins/live/web";
import { useServerHealth } from "@plugins/apps/plugins/deploy/plugins/health/web";
import {
  deleteDeployment,
  deployRuns,
  runDeployment,
  type Deployment,
} from "../../core";
import { runningOnServer } from "../internal/deploy-runs";
import { DeleteDeploymentDialog } from "./delete-deployment-dialog";
import { symbol } from "@plugins/ui/plugins/icons/core";

const deleteIcon = symbol("delete");
const rocketLaunchIcon = symbol("rocket-launch");

/** Trailing-action slot for the Deployments list rows. */
export const DeploymentItemActions = defineItemActions<Deployment>();

/**
 * Why a verb cannot be launched right now, as the sentence to put in the tooltip
 * — or `null` when it can.
 *
 * Two kinds of reason, and both are facts this app already holds: a run is
 * already in flight on the box, or the probe has not established a platform for
 * it (never checked / last check failed / reported something no release targets —
 * spelled out separately rather than folded into one null test). Until both
 * facts have loaded, that is the reason: a launch is never offered on a guess.
 *
 * The probe ones deliberately MIRROR the CLI's own refusals rather than replacing
 * them: the platform a deploy needs is discovered by that probe, so a button that
 * would certainly be refused says so before it is pressed. Every other refusal
 * stays the CLI's, reported after the fact on the row.
 *
 * Exported because the deployment pane's Deploy button gates on the same facts.
 * Sharing the hook rather than the sentences is the point: a row tooltip and the
 * pane's primary action must never disagree about why something is blocked.
 */
export function useBlockedReason(deployment: Deployment): string | null {
  const runsResult = useLive(deployRuns);
  const health = useServerHealth(deployment.serverId);

  // Gated, not collapsed to an empty map: until the run state has arrived we do
  // not know whether something is already running on this box, and launching a
  // second converge into that gap is exactly what the exclusivity rule forbids.
  if (runsResult.status === "loading") return "Loading deploy state…";
  // A failed read is a reason too — never a green light, never a spinner.
  if (runsResult.status === "error") {
    return `Couldn't load deploy state: ${runsResult.error.message}`;
  }
  // Gated, not read as "never verified": a server whose verdict has not loaded
  // may well be verified, and saying otherwise sends the user to re-verify it.
  if (health.status === "loading") return "Loading server health…";
  if (health.status === "error") {
    return `Couldn't load server health: ${health.error.message}`;
  }

  const busy = runningOnServer(runsResult.data, deployment.serverId);
  if (busy) {
    // "The <verb>", never "A <verb>": the verb set now includes `update`, and an
    // indefinite article picked by hand is a sentence that reads wrong the first
    // time someone adds a vowel.
    return busy.deploymentId === deployment.id
      ? `The ${busy.verb} of this deployment is still running.`
      : `The ${busy.verb} of "${busy.compositionId}" is running on this server.`;
  }
  if (!health.found) {
    return "This server has never been verified — run Verify connection first.";
  }
  if (!health.row.ok) {
    return "This server failed its last reachability check — run Verify connection again.";
  }
  if (!health.row.platform) {
    return "This server reported a platform no release targets, so no bundle can be built for it.";
  }
  return null;
}

/**
 * Launch `update` — the whole deploy, as one press: converge the host, build a
 * candidate unless the bundle is already cut from this HEAD, then ship that
 * exact run behind the CLI's remote health gate.
 *
 * ONE action rather than the `converge` and `ship` pair this replaces. Those two
 * were the constraint chain rendered as buttons — ship refuses on an unconverged
 * host, and refuses without a platform-matched bundle — and the chain is now the
 * phases of a single run, sequenced server-side. Neither could do anything
 * `update` does not: converge is its first leg and genuinely a no-op the second
 * time, and ship is its last, differing only by skipping the build (which
 * `compareToHead` already skips when nothing moved). The pane's Deploy button
 * gave up the same two buttons for the same reason; a row that kept them made
 * the same deployment answer to two different vocabularies.
 *
 * `converge`/`ship` alone remain CLI verbs — `./equin deploy converge`
 * repairs host drift without restarting what is serving — but a bare icon on a
 * list row is the wrong place to offer a partial deploy, because the row has
 * nowhere to say which part it left out.
 */
export function DeployAction({
  row,
}: ItemActionProps<Deployment>): ReactElement {
  const blocked = useBlockedReason(row);
  const run = useEndpointMutation(runDeployment);
  return (
    <IconButton
      icon={rocketLaunchIcon}
      label="Deploy"
      tooltip={
        blocked ??
        `Converge, build if needed, and ship ${row.compositionId} to this server`
      }
      disabled={blocked !== null || run.isPending}
      onClick={(e) => {
        e.stopPropagation();
        run.mutate({ params: { id: row.id }, body: { verb: "update" } });
      }}
    />
  );
}

/** Forget the deployment record. The converged host is left untouched. */
export function DeleteDeploymentAction({
  row,
}: ItemActionProps<Deployment>): ReactElement {
  // Predicted: the row leaves the list at once and the dialog closes with
  // it; a refusal is the rejection toast.
  const remove = useLiveMutation(deleteDeployment);
  return (
    <IconButton
      icon={deleteIcon}
      label="Delete deployment"
      onClick={(e) => {
        e.stopPropagation();
        // Fire-and-forget: returning the openDialog promise would pend the
        // button for the dialog's whole open lifetime rather than the delete's.
        void openDialog(
          (close) => (
            <DeleteDeploymentDialog
              deployment={row}
              onCancel={close}
              onConfirm={() => {
                remove.mutate({ params: { id: row.id } });
                close();
              }}
            />
          ),
          { size: "sm" },
        );
      }}
    />
  );
}
