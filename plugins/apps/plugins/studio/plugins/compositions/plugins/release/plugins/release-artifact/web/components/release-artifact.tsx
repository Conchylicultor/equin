import type { ReactElement } from "react";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  previewEndpoint,
  stopPreviewEndpoint,
  releaseRuns,
  releasePreviews,
} from "@plugins/release/core";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const playArrowIcon = symbol("play-arrow");
const stopIcon = symbol("stop");

export function ReleaseArtifact({ runId }: { runId: string }): ReactElement {
  const runResult = useLiveRow(releaseRuns, runId);
  const previewResult = useLive(releasePreviews);

  const startPreview = useEndpointMutation(previewEndpoint);
  const stopPreview = useEndpointMutation(stopPreviewEndpoint);

  if (runResult.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the release run"
        error={runResult.error}
        refetch={runResult.refetch}
      />
    );
  }
  if (previewResult.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the release previews"
        error={previewResult.error}
        refetch={previewResult.refetch}
      />
    );
  }
  if (runResult.status === "loading" || previewResult.status === "loading") {
    return <Loading />;
  }

  if (!runResult.found) {
    return (
      <Text as="p" variant="caption" className="text-muted-foreground">
        Run not found
      </Text>
    );
  }
  const run = runResult.row;

  const preview = previewResult.data[runId];
  const isPreviewRunning = preview?.status === "running";
  const canPreview = run.status === "succeeded" && !isPreviewRunning;

  return (
    <Stack gap="md">
      <Stack gap="2xs">
        <Text as="span" variant="caption" className="text-muted-foreground">
          Artifact
        </Text>
        {run.artifactPath ? (
          <code className="text-code break-all">{run.artifactPath}</code>
        ) : (
          <Text as="span" variant="body" className="text-muted-foreground">
            No artifact yet
          </Text>
        )}
      </Stack>

      <Cluster gap="sm">
        {isPreviewRunning ? (
          <Button
            variant="outline"
            loading={stopPreview.isPending}
            onClick={() => stopPreview.mutate({ params: { id: runId } })}
          >
            <Icon icon={stopIcon} className="size-4" />
            Stop preview
          </Button>
        ) : (
          <Button
            variant="default"
            loading={startPreview.isPending}
            disabled={!canPreview}
            onClick={() => startPreview.mutate({ params: { id: runId } })}
          >
            <Icon icon={playArrowIcon} className="size-4" />
            Preview
          </Button>
        )}

        {isPreviewRunning && preview && (
          <LinkChip
            mono
            leading={<Icon icon={navIcons.newTab} />}
            title="Open preview in a new tab"
            activation={() => {
              window.open(preview.url, "_blank", "noopener,noreferrer");
            }}
          >
            {preview.url}
          </LinkChip>
        )}
      </Cluster>
    </Stack>
  );
}
