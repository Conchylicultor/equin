import type { ReactNode } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  cn,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { LiveLogChannel } from "@plugins/primitives/plugins/log-channels/web";
import {
  ElapsedTime,
  RelativeTime,
} from "@plugins/primitives/plugins/relative-time/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  useBlockedReason,
  type SiteBannerAnswer,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import {
  DEPLOY_LOG_CHANNEL,
  deployRunHistory,
  deployRuns,
  runDeployment,
  type Deployment,
  type DeployPhase,
  type DeployRun,
  type DeployRunRecord,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { useServerHealth } from "@plugins/apps/plugins/deploy/plugins/health/web";
import { RELEASE_LOG_CHANNEL } from "@plugins/release/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { runningCommit, shortSha } from "../../core";

const rocketIcon = symbol("rocket-launch");
const commitIcon = symbol("commit");
const checkIcon = symbol("check");

/** The legs of an `update`, in the order they run, as the strip names them. */
const PHASES: ReadonlyArray<{ id: DeployPhase; title: string }> = [
  { id: "converge", title: "Converge host" },
  { id: "build", title: "Build bundle" },
  { id: "ship", title: "Ship & health-check" },
];

/** What the live run map says of this site: its most recent run, if any. */
function useLatestRun(
  deploymentId: string,
): ResourceResult<DeployRun | undefined> {
  return mapResource(useLive(deployRuns), (runs) => runs[deploymentId]);
}

function useRunningCommit(deploymentId: string) {
  return useLive(runningCommit, { deploymentId });
}

/** "1m 45s" — wall-clock time a run took. */
function tookLabel(startedAt: Date, finishedAt: Date): string {
  const s = Math.max(
    0,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  );
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

// ─── Header action ──────────────────────────────────────────────────────────

/**
 * **Deploy** — the site page's primary action: launches `update` (converge →
 * build unless current → ship that pinned run). Its label says what pressing it
 * would do now: Deploying… while a run is in flight, Retry deploy after a
 * failure, Deploy N commits while `main` is ahead of what is running, else
 * Redeploy. Disabled, with the reason as its tooltip, by the same
 * `useBlockedReason` the list row's Deploy gates on.
 */
export function DeployButton({ deployment }: SiteProps): ReactNode {
  const blocked = useBlockedReason(deployment);
  const latest = useLatestRun(deployment.id);
  const commit = useRunningCommit(deployment.id);
  const deploy = useEndpointMutation(runDeployment);

  const run = latest.status === "ready" ? latest.data : undefined;
  const running = run?.status === "running";
  // Until both reads land the label claims nothing about state: plain Deploy.
  const known = latest.status === "ready" && commit.status === "ready";
  const label = !known
    ? "Deploy"
    : running
      ? "Deploying…"
      : run?.status === "failed"
        ? "Retry deploy"
        : commit.status === "ready" &&
            commit.data.kind === "known" &&
            commit.data.behindMain > 0
          ? `Deploy ${plural(commit.data.behindMain, "commit")}`
          : run === undefined &&
              commit.status === "ready" &&
              commit.data.kind === "unknown"
            ? "Deploy"
            : "Redeploy";

  return (
    <Button
      disabled={blocked !== null || running}
      tooltip={blocked ?? undefined}
      loading={deploy.isPending || running}
      onClick={() =>
        deploy.mutate({
          params: { id: deployment.id },
          body: { verb: "update" },
        })
      }
    >
      <Icon icon={rocketIcon} />
      {label}
    </Button>
  );
}

// ─── Strip cells ────────────────────────────────────────────────────────────

function Faint({ children }: { children: ReactNode }): ReactNode {
  return (
    <Text as="span" variant="label" tone="muted">
      {children}
    </Text>
  );
}

/** The newest run in the durable ledger — what the live map forgets on a restart. */
function useNewestRecord(deploymentId: string) {
  return useLive(deployRunHistory, {
    where: { deploymentId },
    orderBy: [["startedAt", "desc"]],
    limit: 1,
  });
}

/**
 * Status: what the box is doing — the live run while one is in flight (its
 * leg), else the newest run's outcome, from the live map or (after a restart
 * emptied it) the ledger.
 */
export function StatusCell({ deployment }: SiteProps): ReactNode {
  const latest = useLatestRun(deployment.id);
  const newest = useNewestRecord(deployment.id);
  if (latest.status === "loading" || newest.status === "loading") {
    return <Loading />;
  }
  if (latest.status === "error" || newest.status === "error") {
    const failed = latest.status === "error" ? latest : newest;
    if (failed.status !== "error") return null;
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the deploy state"
        error={failed.error}
        refetch={failed.refetch}
      />
    );
  }
  const live = latest.data;
  if (live?.status === "running") {
    const phase = PHASES.find((p) => p.id === live.phase);
    return (
      <>
        <StatusDot colorClass="bg-primary animate-pulse" />
        <Text as="span" variant="label">
          {phase ? phase.title : `Running ${live.verb}`}
          {live.commitSha ? ` · ${shortSha(live.commitSha)}` : ""}
        </Text>
      </>
    );
  }
  const record = newest.data[0];
  const outcome = live
    ? { status: live.status, phase: live.phase }
    : record
      ? { status: record.status, phase: record.phaseFailed }
      : null;
  if (outcome === null) return <Faint>Not deployed yet</Faint>;
  switch (outcome.status) {
    case "running":
      return (
        <>
          <StatusDot colorClass="bg-primary animate-pulse" />
          <Text as="span" variant="label">
            Running
          </Text>
        </>
      );
    case "succeeded":
      return (
        <>
          <StatusDot colorClass="bg-success" />
          <Text as="span" variant="label">
            Healthy
          </Text>
        </>
      );
    case "failed":
      return (
        <>
          <StatusDot colorClass="bg-destructive" />
          <Text as="span" variant="label">
            {outcome.phase ? `Failed on ${outcome.phase}` : "Last run failed"}
          </Text>
        </>
      );
    case "needs-approval":
      return (
        <>
          <StatusDot colorClass="bg-warning" />
          <Text as="span" variant="label">
            Waiting for approval
          </Text>
        </>
      );
  }
}

/** Running: the commit live on the box (sha + subject). */
export function RunningCell({ deployment }: SiteProps): ReactNode {
  const commit = useRunningCommit(deployment.id);
  if (commit.status === "loading") return <Loading />;
  if (commit.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the running commit"
        error={commit.error}
        refetch={commit.refetch}
      />
    );
  }
  if (commit.data.kind === "unknown") {
    return (
      <Text as="span" variant="label" tone="muted" title={commit.data.reason}>
        Unknown
      </Text>
    );
  }
  return (
    <>
      <Badge variant="muted" mono tooltip={commit.data.sha}>
        {shortSha(commit.data.sha)}
      </Badge>
      <Text as="span" variant="body" tone="muted">
        {commit.data.subject}
      </Text>
    </>
  );
}

/** The newest succeeded shipping run (`ship` / `update`) — what is live now. */
function useLiveShip(deploymentId: string) {
  return useLive(deployRunHistory, {
    where: {
      deploymentId,
      status: "succeeded",
      verb: { in: ["ship", "update"] },
    },
    orderBy: [["startedAt", "desc"]],
    limit: 1,
  });
}

/** Deployed: when what is live shipped, and how long that run took. */
export function DeployedCell({ deployment }: SiteProps): ReactNode {
  const live = useLiveShip(deployment.id);
  if (live.status === "loading") return <Loading />;
  if (live.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the last deploy"
        error={live.error}
        refetch={live.refetch}
      />
    );
  }
  const run: DeployRunRecord | undefined = live.data[0];
  if (!run) return <Faint>Never</Faint>;
  const finished = run.finishedAt ?? run.startedAt;
  return (
    <Text as="span" variant="label">
      <RelativeTime date={finished} />
      {run.finishedAt ? ` · ${tookLabel(run.startedAt, run.finishedAt)}` : ""}
    </Text>
  );
}

/** Bundle: the platform it is built for, and whether it is behind `main`. */
export function BundleCell({ deployment }: SiteProps): ReactNode {
  const commit = useRunningCommit(deployment.id);
  const health = useServerHealth(deployment.serverId);
  if (commit.status === "loading" || health.status === "loading") {
    return <Loading />;
  }
  if (commit.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the running commit"
        error={commit.error}
        refetch={commit.refetch}
      />
    );
  }
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
  const platform =
    health.status === "ready" && health.found && health.row.ok
      ? health.row.platform
      : null;
  const prefix = platform ? `${platform} · ` : "";
  if (commit.data.kind === "unknown") {
    // Unknown has several reasons (nothing shipped, no commit recorded, a sha
    // this repo has never seen) — name it rather than claim one.
    return (
      <Text as="span" variant="label" tone="muted" title={commit.data.reason}>
        {prefix}Unknown
      </Text>
    );
  }
  const behind = commit.data.behindMain;
  return behind > 0 ? (
    <Text as="span" variant="label" className="text-warning">
      {prefix}
      {plural(behind, "commit")} behind main
    </Text>
  ) : (
    <Text as="span" variant="label">
      {prefix}up to date with main
    </Text>
  );
}

// ─── Banners ────────────────────────────────────────────────────────────────

/**
 * Deploying: the run in flight, as the three legs it walks through and the
 * tail of the log the current leg writes to.
 */
export function useDeployingBanner({
  deployment,
}: SiteProps): SiteBannerAnswer {
  const latest = useLatestRun(deployment.id);
  if (latest.status === "loading") return "pending";
  // A banner is attention, not data: no banner until the run is known.
  const run = latest.status === "ready" ? latest.data : undefined;
  if (run?.status !== "running") return null;
  return {
    tone: "info",
    icon: rocketIcon,
    title: run.commitSha
      ? `Deploying ${shortSha(run.commitSha)}`
      : `Running ${run.verb}`,
    body: run.commitSubject ?? undefined,
    detail: <DeployProgress run={run} deployment={deployment} />,
  };
}

/** Behind main: `main` has commits the box is not running. */
export function useBehindMainBanner({
  deployment,
}: SiteProps): SiteBannerAnswer {
  const commit = useRunningCommit(deployment.id);
  if (commit.status === "loading") return "pending";
  const known =
    commit.status === "ready" && commit.data.kind === "known"
      ? commit.data
      : null;
  if (known === null) return null;
  const { behindMain } = known;
  if (behindMain === 0) return null;
  const name = deployment.hostnames[0] ?? deployment.compositionId;
  return {
    tone: "warning",
    icon: commitIcon,
    title: `main is ${plural(behindMain, "commit")} ahead`,
    body: `of what ${name} is running. Deploy rebuilds the bundle and ships it.`,
  };
}

function DeployProgress({
  run,
  deployment,
}: {
  run: DeployRun;
  deployment: Deployment;
}): ReactNode {
  return (
    <Stack gap="none" className="divide-y divide-border/60">
      <Inset x="md" y="sm">
        <Stack direction="row" align="center" gap="md" wrap>
          {run.verb === "update" ? (
            <PhaseSteps run={run} />
          ) : (
            <Text as="span" variant="label">
              {run.verb}
            </Text>
          )}
          <Fill />
          <Text as="span" variant="caption" tone="faint">
            {deployment.compositionId} ·{" "}
            <ElapsedTime since={new Date(run.startedAt)} />
          </Text>
        </Stack>
      </Inset>
      <LogTail run={run} />
    </Stack>
  );
}

/** The three legs of an `update`, left to right: done · running · upcoming. */
function PhaseSteps({ run }: { run: DeployRun }): ReactNode {
  const current = PHASES.findIndex((p) => p.id === run.phase);
  return (
    <Inline gap="md">
      {PHASES.map((phase, i) => {
        const state =
          i < current ? "done" : i === current ? "active" : "upcoming";
        return (
          <Inline key={phase.id} gap="xs">
            {i > 0 && (
              <Separator
                className={cn("w-12", state !== "upcoming" && "bg-success")}
              />
            )}
            {state === "done" ? (
              <span className="text-success">
                <Icon icon={checkIcon} />
              </span>
            ) : state === "active" ? (
              <Spinner shape="ring" className="text-primary-text" />
            ) : (
              <StatusDot ringClass="border-border" />
            )}
            <Text
              as="span"
              variant="label"
              tone={
                state === "upcoming"
                  ? "faint"
                  : state === "done"
                    ? "muted"
                    : "strong"
              }
            >
              {phase.title}
            </Text>
          </Inline>
        );
      })}
    </Inline>
  );
}

/**
 * The tail of the channel the running leg writes to — the build leg writes to
 * the release channel, the other two to the deploy channel — keyed on it, so a
 * leg change resubscribes rather than leaving the last leg's lines under it.
 */
function LogTail({ run }: { run: DeployRun }): ReactNode {
  const channel =
    run.phase === "build" ? RELEASE_LOG_CHANNEL : DEPLOY_LOG_CHANNEL;
  return (
    <Inset x="md" y="sm" className="bg-background">
      <LiveLogChannel
        key={channel}
        channel={channel}
        className="max-h-32"
        emptyState="Nothing on this channel yet."
      />
    </Inset>
  );
}
