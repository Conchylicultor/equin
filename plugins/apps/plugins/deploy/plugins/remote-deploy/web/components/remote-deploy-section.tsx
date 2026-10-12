import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  Step,
  StepNote,
  Steps,
  type StepState,
} from "@plugins/primitives/plugins/setup-steps/web";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  useServerHealth,
  type ServerHealthRow,
} from "@plugins/apps/plugins/deploy/plugins/health/web";
import { useBlockedReason } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import {
  deployments,
  deployRuns,
  loopbackOnlySentence,
  publicUrls,
  runDeployment,
  type Deployment,
  type DeployPhase,
  type DeployRun,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import type { PlatformTag } from "@plugins/release/core";
import { bundleRefusalMessage } from "@plugins/release/plugins/bundles/core";
import { shortSha, stalenessChipLabel, stalenessSentence } from "../../core";
import { useReleaseInfo, type ReleaseInfo } from "../internal/use-release-info";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const rocketLaunchIcon = symbol("rocket-launch");

/**
 * The three legs of an `update`, in the order they run — the same closed list
 * `DeployPhase` names, spelled once here for the report.
 */
const PHASES: ReadonlyArray<{ id: DeployPhase; title: string }> = [
  { id: "converge", title: "Converge the host" },
  { id: "build", title: "Build the candidate" },
  { id: "ship", title: "Ship it" },
];

/**
 * **Deploy to server** — one button, and everything needed to trust pressing it.
 *
 * The four-step pipeline this replaces was a faithful rendering of a real
 * constraint chain (ship refuses on an un-converged host, and refuses without a
 * packed, platform-matched bundle). The chain did not go away — it became the
 * phases of ONE run, sequenced server-side and *reported* here. The two facts
 * that made that safe: converge is genuinely a no-op the second time, and
 * `resolveBundle` + `compareToHead` already answer "do I need to build?" without
 * asking anyone.
 *
 * Everything it reads — the deployment's row, the run map and the server's
 * probe verdict — is gated by hand before anything paints, so it can never
 * paint from a half-loaded snapshot: "no verified platform" or "never run"
 * shown only because a read had not landed would be exactly the
 * wrong-state-while-loading bug. (By hand because a row read has no `data` for
 * `useCombinedResources` to combine.)
 */
export function RemoteDeploySection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const deployment = useLiveRow(deployments, deploymentId);
  const runs = useLive(deployRuns);

  // Precedence error > loading: one failed read fails the section.
  if (deployment.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the deployment"
        error={deployment.error}
        refetch={deployment.refetch}
      />
    );
  }
  if (runs.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the deploy runs"
        error={runs.error}
        refetch={runs.refetch}
      />
    );
  }
  if (deployment.status === "loading" || runs.status === "loading") {
    return <Loading variant="rows" />;
  }
  if (!deployment.found) {
    return (
      <Placeholder tone="error">This deployment no longer exists.</Placeholder>
    );
  }
  return (
    <RemoteDeployHealth
      deployment={deployment.row}
      run={runs.data[deployment.row.id]}
    />
  );
}

/** Waits for the server's probe verdict — the platform everything below labels. */
function RemoteDeployHealth({
  deployment,
  run,
}: {
  deployment: Deployment;
  run: DeployRun | undefined;
}): ReactNode {
  const health = useServerHealth(deployment.serverId);
  if (health.status === "loading") return <Loading variant="rows" />;
  if (health.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the server's health"
        error={health.error}
        refetch={health.refetch}
      />
    );
  }
  return (
    <RemoteDeploy
      deployment={deployment}
      run={run}
      health={health.found ? health.row : null}
    />
  );
}

function RemoteDeploy({
  deployment,
  run,
  health,
}: {
  deployment: Deployment;
  run: DeployRun | undefined;
  /** The server's last probe verdict, or `null` — it has never been checked. */
  health: ServerHealthRow | null;
}): ReactNode {
  // The same hook the row's Deploy button gates on — the row launches the same
  // `update` verb — so a tooltip and this button can never disagree about why
  // something is blocked.
  const blocked = useBlockedReason(deployment);
  // Never a picker: the platform a deploy needs is DISCOVERED by the probe, and
  // a field with a default is a field someone sets back to the wrong value. The
  // orchestrator reads the same fact server-side; this copy only labels.
  const platform: PlatformTag | null = (health?.ok && health.platform) || null;
  const info = useReleaseInfo(deployment.compositionId, platform);

  const deploy = useEndpointMutation(runDeployment);
  const urls = publicUrls(deployment.hostnames);

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Button
          className="w-fit"
          disabled={blocked !== null}
          title={blocked ?? undefined}
          loading={deploy.isPending}
          onClick={() =>
            deploy.mutate({
              params: { id: deployment.id },
              body: { verb: "update" },
            })
          }
        >
          <Icon icon={rocketLaunchIcon} />
          {platform ? `Deploy ${platform}` : "Deploy"}
        </Button>
        <Text as="p" variant="caption" tone="muted">
          Converges the host, builds a {platform ?? "matching"} candidate unless
          one is already current, then ships that exact run behind the
          CLI&apos;s remote health gate.
        </Text>
        {blocked && (
          <Text as="p" variant="caption" tone="destructive">
            {blocked}
          </Text>
        )}
      </Stack>

      {/* Rendered for the whole life of an update — including after it ends —
          because "which leg did it fail on" is the first thing anyone asks, and
          a strip that vanished on failure would answer it by hiding. */}
      {run?.verb === "update" && <PhaseReport run={run} />}

      <Provenance info={info} />

      <Stack gap="2xs">
        <Text as="span" variant="label">
          Inspect the deployed app
        </Text>
        {urls.length > 0 ? (
          <Cluster gap="xs">
            {urls.map((url) => (
              <LinkChip
                key={url}
                mono
                title={`Open ${url}`}
                activation={() => window.open(url, "_blank", "noopener")}
              >
                {url}
              </LinkChip>
            ))}
          </Cluster>
        ) : (
          <Text as="p" variant="caption" tone="muted">
            {loopbackOnlySentence(deployment.loopbackPort)}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

/**
 * Where the running (or last) update got to — a REPORT, not a set of controls.
 *
 * `Steps`/`Step` is reused for exactly the state vocabulary it already carries
 * (done shows a check; upcoming dims AND marks the step inert), which is what a
 * progress strip wants and what a hand-rolled row of dots would have to
 * re-derive. Nothing inside a step is clickable — the sequence is the server's.
 */
function PhaseReport({ run }: { run: DeployRun }): ReactNode {
  const currentIndex = PHASES.findIndex((p) => p.id === run.phase);
  const failed = run.status === "failed";

  return (
    <Stack gap="xs">
      <Steps>
        {PHASES.map((phase, i) => (
          <Step
            key={phase.id}
            title={phase.title}
            state={stateOf(i, currentIndex, run.status)}
          >
            {i === currentIndex && failed && run.message && (
              <Text
                as="p"
                variant="caption"
                tone="destructive"
                className="whitespace-pre-wrap"
              >
                {run.message}
              </Text>
            )}
          </Step>
        ))}
      </Steps>
      {run.status === "succeeded" && (
        <Text as="p" variant="caption" tone="muted">
          Shipped {run.release ?? "the resolved bundle"}
          {run.finishedAt && (
            <>
              {" — "}
              <RelativeTime date={new Date(run.finishedAt)} />
            </>
          )}
          .
        </Text>
      )}
    </Stack>
  );
}

/**
 * A phase's position relative to the one the run is on. A finished run leaves
 * `phase` at the leg it ended on, so a success marks every phase done while a
 * failure leaves the failing leg `active` — which is where its message is.
 */
function stateOf(
  index: number,
  currentIndex: number,
  status: DeployRun["status"],
): StepState {
  if (status === "succeeded") return "done";
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "active";
  return "upcoming";
}

/**
 * What Deploy would send, and how it relates to the source — rendered ALWAYS, in
 * every state, because "you tested X, you are shipping X" is the one question
 * this pane exists to answer and a silent surface answers it by implication.
 *
 * When there is no bundle, the CLI's own refusal is shown verbatim:
 * `resolveBundle` is the authority on shippability and this UI never re-derives
 * it, so the sentence a user reads here is the sentence `ship` would print. It
 * is NOT a blocker for the button — Deploy builds one — but it is what the
 * button would have to start from.
 */
function Provenance({ info }: { info: ReleaseInfo }): ReactNode {
  switch (info.status) {
    case "loading":
      return <Loading label="Resolving what is built…" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          error={info.error}
          refetch={info.refetch}
          subject="what is built for this server"
        />
      );
    case "ready":
      break;
  }
  if (info.data.kind === "no-platform") {
    return (
      <StepNote>
        No verified platform for this server yet, so there is no candidate to
        resolve.
      </StepNote>
    );
  }

  const { resolution, staleness } = info.data.candidate;

  if (!resolution.ok) {
    return (
      <Stack gap="2xs">
        <Text as="p" variant="label">
          Nothing built yet — Deploy will build it
        </Text>
        <Text
          as="p"
          variant="caption"
          tone="muted"
          className="whitespace-pre-wrap"
        >
          {bundleRefusalMessage(resolution.refusal)}
        </Text>
      </Stack>
    );
  }

  const { manifest } = resolution;
  const sha = manifest.commitSha ?? null;

  return (
    <Stack gap="xs">
      <Text as="span" variant="label">
        What is built for this server
      </Text>
      <Cluster gap="xs">
        <Badge variant="muted" mono>
          {manifest.platform}
        </Badge>
        <Badge variant="muted" mono title={sha ?? undefined}>
          {sha ? shortSha(sha) : "no commit recorded"}
        </Badge>
        <Badge variant="muted">
          built <RelativeTime date={new Date(manifest.builtAt)} />
        </Badge>
        <Badge variant={staleness.kind === "current" ? "success" : "warning"}>
          {stalenessChipLabel(staleness)}
        </Badge>
      </Cluster>
      <Text as="p" variant="caption" tone="muted">
        {stalenessSentence(staleness)}{" "}
        {staleness.kind === "current"
          ? "Deploy will reuse it rather than recompiling."
          : "Deploy will rebuild before shipping."}
      </Text>
    </Stack>
  );
}
