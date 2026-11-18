import { buildDetailRoute } from "@plugins/build/core";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import {
  cutReleaseEndpoint,
  upstreamPublisherStatus,
} from "@plugins/upstream/plugins/release/core";
import {
  commitLineParts,
  githubPublication,
  releasesBody,
  type CommitLine,
  type Publisher,
  type ReleaseAction,
} from "../internal/releases-view";

/** Re-read "6h ago" and the next tag's day once a minute while drawn. */
const NOW_TICK_MS = 60_000;

/**
 * The release row's body on the checkout that publishes releases: the
 * unreleased commits and the Release button (`./equin version cut`, run by
 * main's backend). Nothing elsewhere — the row itself is absent there.
 */
export function ReleasesGlance() {
  const read = useLive(upstreamPublisherStatus);
  const now = useNow(NOW_TICK_MS);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  switch (read.status) {
    case "loading":
    case "unavailable":
      return null;
    case "error":
      // The row's own summary says the read failed (`releasesHealth`).
      return null;
    case "ready":
      break;
  }
  if (read.data.kind !== "publisher") return null;
  const release = async (): Promise<void> => {
    const result = await fetchEndpoint(cutReleaseEndpoint, {});
    if (result.kind === "unavailable") {
      toast({
        type: "release-cut-unavailable",
        title: "Not released",
        description: result.message,
        variant: "error",
        category: "updates",
      });
      return;
    }
    const cut = result.value;
    toast(
      cut.kind === "released"
        ? {
            type: "release-cut",
            title: "Released",
            description: cut.detail,
            variant: "success",
            category: "updates",
          }
        : {
            type: "release-cut-failed",
            title: "Not released",
            description: cut.detail,
            variant: "error",
            category: "updates",
          },
    );
  };
  return (
    <ReleasesBodyView
      status={read.data}
      now={new Date(now)}
      onRelease={release}
    />
  );
}

/**
 * The body as drawn from a status — what the glance renders and the exhibit
 * shows in each state. `onRelease` cuts the release (the button pends on it).
 */
export function ReleasesBodyView({
  status,
  now,
  onRelease,
}: {
  status: Publisher;
  now: Date;
  onRelease: () => Promise<void>;
}) {
  const body = releasesBody(status, now);
  const runUrl = openableRun(status);
  return (
    <Stack gap="sm">
      <CommitLineView line={body.line} />
      {body.action === null && runUrl === null ? null : (
        <Line className="gap-sm">
          {body.action === null ? null : (
            <ReleaseActions action={body.action} onRelease={onRelease} />
          )}
          {runUrl === null ? null : <OpenRun url={runUrl} />}
        </Line>
      )}
    </Stack>
  );
}

/**
 * The GitHub run worth opening: the newest release's run while GitHub is
 * still on it or after it failed — not once all is published.
 */
function openableRun(status: Publisher): string | null {
  if (status.github === null) return null;
  const gh = githubPublication(status.github);
  return gh.health === "attention" || gh.pulsing ? gh.runUrl : null;
}

/** "Open run": the release workflow's run on GitHub, in a new tab. */
function OpenRun({ url }: { url: string }) {
  return (
    <Button
      variant="ghost"
      tooltip="The release workflow's run on GitHub"
      render={<a href={url} target="_blank" rel="noopener noreferrer" />}
    >
      Open run
    </Button>
  );
}

function CommitLineView({ line }: { line: CommitLine }) {
  const { count, rest } = commitLineParts(line);
  return (
    <Text variant="caption" tone="muted" className="tabular-nums">
      {count === null ? null : (
        <span className="font-semibold text-foreground">{count}</span>
      )}
      {rest}
    </Text>
  );
}

function ReleaseActions({
  action,
  onRelease,
}: {
  action: ReleaseAction;
  onRelease: () => Promise<void>;
}) {
  return (
    <>
      <Button
        variant="secondary"
        disabled={!action.enabled}
        tooltip={action.tooltip}
        onClick={onRelease}
      >
        {action.label}
      </Button>
      {action.failedRunId === null ? null : (
        <OpenBuild runId={action.failedRunId} />
      )}
    </>
  );
}

function OpenBuild({ runId }: { runId: string }) {
  const appLinkProps = useAppLinkProps();
  return (
    <Button
      {...appLinkProps(buildDetailRoute.link(debugApp, { runId }))}
      variant="ghost"
    >
      Open build
    </Button>
  );
}
