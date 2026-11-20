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
  // Only an `update` has legs to draw; a converge, ship or restart is one step,
  // which the row's summary and action already say.
  if (run?.status !== "running" || run.verb !== "update") return null;
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

// ─── Deploy / Restart site (SiteLive.Action) ─────────────────────────────────

/**
 * The row's primary action — the next step for the site — and why it cannot
 * be pressed:
 *
 * - **Restart site** while the server answers but equin does not (`down`):
 *   the `restart` verb — the service restarted on the release it already
 *   has, behind the ship's health gate, recorded as a run. Drawn pending
 *   ("Restarting…") while that run is in flight.
 * - **Deploy** when main is ahead or the release is too old for the link;
 *   blocked — with the reason — while the connection to the box is lost.
 * - Nothing while a deploy runs (the row shows it), after a run failed
 *   (Investigate is the next step), or while the site is live and current.
 */
type RowAction =
  | { kind: "hidden" }
  | { kind: "deploy"; blocked: string | null }
  | { kind: "restart"; running: boolean };

function rowActionOf(site: SiteHealth): RowAction {
  const { run, release } = site;
  if (run?.status === "running") {
    return run.verb === "restart"
      ? { kind: "restart", running: true }
      : { kind: "hidden" };
  }
  if (run?.status === "failed") return { kind: "hidden" };
  if (site.link.kind === "linked") {
    switch (site.link.link.state.kind) {
      case "reconnecting":
        return {
          kind: "deploy",
          blocked: "Waiting for the connection to come back",
        };
      case "unreachable":
        return {
          kind: "deploy",
          blocked: "The server can't be reached over SSH",
        };
      case "refused":
        return {
          kind: "deploy",
          blocked: "Fix the connection to the server first",
        };
      case "down":
        return { kind: "restart", running: false };
      case "outdated":
        return { kind: "deploy", blocked: null };
      case "connecting":
      case "live":
        break;
    }
  }
  return release.kind === "known" && release.behindMain > 0
    ? { kind: "deploy", blocked: null }
    : { kind: "hidden" };
}

const DEPLOY_TIP =
  "Build, upload and switch with no downtime — reverted on its own if the new version fails its health check";
const RESTART_TIP = "Restart equin's service on the server";

/** The row's action button as it looks: the label, and the reason it is blocked. */
function RowActionButton({
  site,
  action,
  blocked,
  pending,
  onPress,
}: {
  site: SiteHealth;
  action: Exclude<RowAction, { kind: "hidden" }>;
  blocked: string | null;
  pending: boolean;
  onPress?: () => void;
}): ReactNode {
  const restart = action.kind === "restart";
  return (
    <Button
      disabled={blocked !== null}
      tooltip={blocked ?? (restart ? RESTART_TIP : DEPLOY_TIP)}
      loading={pending}
      onClick={onPress}
    >
      {restart
        ? action.running
          ? "Restarting…"
          : "Restart site"
        : deployLabelOf(site.run, site.release)}
    </Button>
  );
}

/** The live button, once the deployment's record is known (its server's gate). */
function LiveRowAction({
  deployment,
  site,
  action,
}: {
  deployment: Deployment;
  site: SiteHealth;
  action: Exclude<RowAction, { kind: "hidden" }>;
}): ReactNode {
  // The same gate as the site page's Deploy (something already running on the
  // server, an unverified server), after the link's own reason. A restart in
  // flight is the thing running, so it is drawn pending instead.
  const serverBlocked = useBlockedReason(deployment);
  const run = useEndpointMutation(runDeployment);
  const running = action.kind === "restart" && action.running;
  return (
    <RowActionButton
      site={site}
      action={action}
      blocked={
        running
          ? null
          : ((action.kind === "deploy" ? action.blocked : null) ??
            serverBlocked)
      }
      pending={running || run.isPending}
      onPress={() =>
        run.mutate({
          params: { id: deployment.id },
          body: { verb: action.kind === "restart" ? "restart" : "update" },
        })
      }
    />
  );
}

/**
 * The health report's site row's primary action: the site page's own
 * `update` (`runDeployment`), labelled as there (`deployLabelOf`), or Restart
 * site (the `restart` verb) while equin is down on the box — whichever is the
 * next step (`rowActionOf`).
 */
export function SiteDeployAction({
  deploymentId,
  site,
}: SiteLiveProps): ReactNode {
  const deployment = rowOrStale(useLive(deployments, { id: deploymentId }));
  const action = rowActionOf(site);
  if (action.kind === "hidden") return null;
  if (deployment === undefined) {
    // The record is still on its way: the button, held until it lands.
    return (
      <RowActionButton
        site={site}
        action={action}
        blocked={action.kind === "deploy" ? action.blocked : null}
        pending={true}
      />
    );
  }
  return <LiveRowAction deployment={deployment} site={site} action={action} />;
}

/** The action in an exhibit state: the same button, gated by the link alone. */
export function SiteDeployActionExhibit({
  site,
}: SiteLiveExhibitProps): ReactNode {
  const action = rowActionOf(site);
  if (action.kind === "hidden") return null;
  return (
    <RowActionButton
      site={site}
      action={action}
      blocked={action.kind === "deploy" ? action.blocked : null}
      pending={action.kind === "restart" && action.running}
    />
  );
}
