import type { ReactNode } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { Meter } from "@plugins/primitives/plugins/css/plugins/meter/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  cn,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useBlockedReason } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import {
  deployments,
  runDeployment,
  type Deployment,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";
import type {
  SiteLiveExhibitProps,
  SiteLiveProps,
} from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import {
  DEPLOY_PHASE_TITLES as PHASES,
  deployLabelOf,
} from "@plugins/apps/plugins/deploy/plugins/remote-deploy/core";

// ─── The deploy in progress (SiteLive.Section) ───────────────────────────────

/**
 * The deploy in progress, in the health report's site row: the `update`'s
 * three legs (done · running · upcoming) over a bar of how far along it is.
 * Nothing while no deploy runs. Drawn from the row's own `site.run`, so the
 * exhibit draws it from its fixture as is.
 */
export function DeployingSection({ site }: SiteLiveProps): ReactNode {
  const { run } = site;
  if (run?.status !== "running") return null;
  const current = PHASES.findIndex((p) => p.id === run.phase);
  return (
    <Stack gap="xs">
      <Line className="gap-xs">
        {PHASES.flatMap((phase, i) => {
          const state =
            i < current ? "done" : i === current ? "active" : "upcoming";
          const step = (
            <Inline key={phase.id} gap="xs" className={rigidClass()}>
              <StatusDot
                colorClass={cn(
                  state === "done"
                    ? "bg-success"
                    : state === "active"
                      ? "bg-primary-text animate-pulse"
                      : "bg-border",
                )}
              />
              <Text
                as="span"
                variant="caption"
                tone={
                  state === "upcoming"
                    ? "faint"
                    : state === "done"
                      ? "muted"
                      : "strong"
                }
              >
                {phase.short}
              </Text>
            </Inline>
          );
          // The rule between two legs takes the line's slack, so the legs
          // spread across the row.
          return i === 0
            ? [step]
            : [
                <Separator
                  key={`${phase.id}-rule`}
                  className={cn(growClass(), "min-w-3.5")}
                />,
                step,
              ];
        })}
      </Line>
      <Meter
        role="progressbar"
        size="thin"
        label="Deploy progress"
        value={current < 0 ? 0 : (current + 0.5) / PHASES.length}
      />
    </Stack>
  );
}

// ─── Deploy (SiteLive.Action) ────────────────────────────────────────────────

/**
 * Whether the site row offers Deploy, and why it cannot be pressed: hidden
 * while a deploy runs (the row shows it) or after one failed (Investigate is
 * the next step), and while the site is live and current; offered when main is
 * ahead, the site is down, or its release is too old for the link; blocked —
 * with the reason — while the connection to the box is lost.
 */
type RowDeploy = { kind: "hidden" } | { kind: "shown"; blocked: string | null };

function rowDeployOf(site: SiteHealth): RowDeploy {
  const { run, release } = site;
  if (run?.status === "running" || run?.status === "failed")
    return { kind: "hidden" };
  if (site.link.kind === "linked") {
    switch (site.link.link.state.kind) {
      case "reconnecting":
        return {
          kind: "shown",
          blocked: "Waiting for the connection to come back",
        };
      case "unreachable":
        return {
          kind: "shown",
          blocked: "The server can't be reached over SSH",
        };
      case "refused":
        return {
          kind: "shown",
          blocked: "Fix the connection to the server first",
        };
      case "down":
      case "outdated":
        return { kind: "shown", blocked: null };
      case "connecting":
      case "live":
        break;
    }
  }
  return release.kind === "known" && release.behindMain > 0
    ? { kind: "shown", blocked: null }
    : { kind: "hidden" };
}

const DEPLOY_TIP =
  "Build, upload and switch with no downtime — reverted on its own if the new version fails its health check";

/** The row's Deploy button as it looks: the label, and the reason it is blocked. */
function RowDeployButton({
  site,
  blocked,
  pending,
  onDeploy,
}: {
  site: SiteHealth;
  blocked: string | null;
  pending: boolean;
  onDeploy?: () => void;
}): ReactNode {
  return (
    <Button
      disabled={blocked !== null}
      tooltip={blocked ?? DEPLOY_TIP}
      loading={pending}
      onClick={onDeploy}
    >
      {deployLabelOf(site.run, site.release)}
    </Button>
  );
}

/** The live button, once the deployment's record is known (its server's gate). */
function LiveRowDeploy({
  deployment,
  site,
  linkBlocked,
}: {
  deployment: Deployment;
  site: SiteHealth;
  linkBlocked: string | null;
}): ReactNode {
  // The same gate as the site page's Deploy (something already running on the
  // server, an unverified server), after the link's own reason.
  const serverBlocked = useBlockedReason(deployment);
  const deploy = useEndpointMutation(runDeployment);
  return (
    <RowDeployButton
      site={site}
      blocked={linkBlocked ?? serverBlocked}
      pending={deploy.isPending}
      onDeploy={() =>
        deploy.mutate({
          params: { id: deployment.id },
          body: { verb: "update" },
        })
      }
    />
  );
}

/**
 * Deploy, in the health report's site row: the site page's own `update`
 * (`runDeployment`), labelled as there (`deployLabelOf`), offered when it is
 * the next step (`rowDeployOf`).
 */
export function SiteDeployAction({
  deploymentId,
  site,
}: SiteLiveProps): ReactNode {
  const deployment = rowOrStale(useLive(deployments, { id: deploymentId }));
  const shown = rowDeployOf(site);
  if (shown.kind === "hidden") return null;
  if (deployment === undefined) {
    // The record is still on its way: the button, held until it lands.
    return (
      <RowDeployButton site={site} blocked={shown.blocked} pending={true} />
    );
  }
  return (
    <LiveRowDeploy
      deployment={deployment}
      site={site}
      linkBlocked={shown.blocked}
    />
  );
}

/** Deploy in an exhibit state: the same button, gated by the link alone. */
export function SiteDeployActionExhibit({
  site,
}: SiteLiveExhibitProps): ReactNode {
  const shown = rowDeployOf(site);
  if (shown.kind === "hidden") return null;
  return (
    <RowDeployButton site={site} blocked={shown.blocked} pending={false} />
  );
}
