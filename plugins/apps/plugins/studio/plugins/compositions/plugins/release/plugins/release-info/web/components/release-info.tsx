import type { ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { releaseRuns, type ReleaseRun } from "@plugins/release/core";

function StatusBadge({ run }: { run: ReleaseRun }): ReactNode {
  if (run.status === "running") {
    return (
      <Badge
        variant="warning"
        icon={<StatusDot colorClass="bg-warning animate-pulse" />}
      >
        Running
      </Badge>
    );
  }
  if (run.status === "succeeded") {
    return (
      <Badge variant="success" icon={<StatusDot colorClass="bg-success" />}>
        Succeeded
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      icon={<StatusDot colorClass="bg-destructive" />}
    >
      {run.exitCode != null ? `Failed (exit ${run.exitCode})` : "Failed"}
    </Badge>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" justify="between" align="baseline" gap="lg">
      <Text as="span" variant="caption" className="text-muted-foreground">
        {label}
      </Text>
      <Text as="span" variant="body">
        {children}
      </Text>
    </Stack>
  );
}

export function ReleaseInfo({ runId }: { runId: string }) {
  const result = useLive(releaseRuns, { id: runId });
  if (result.status === "loading") return <Loading />;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the release run"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  if (!result.found) {
    return (
      <Text as="p" variant="caption" className="text-muted-foreground">
        Run not found
      </Text>
    );
  }
  const run = result.row;

  return (
    <Stack gap="md">
      <Stack direction="row" align="center" gap="sm">
        <StatusBadge run={run} />
      </Stack>

      <Stack gap="sm">
        <Row label="Composition">{run.composition}</Row>
        <Row label="Target">{run.target}</Row>
        {run.platform && <Row label="Platform">{run.platform}</Row>}
        <Row label="Started">
          <RelativeTime date={run.startedAt} />
        </Row>
        {run.finishedAt && (
          <Row label="Finished">
            <RelativeTime date={run.finishedAt} />
          </Row>
        )}
      </Stack>
    </Stack>
  );
}
