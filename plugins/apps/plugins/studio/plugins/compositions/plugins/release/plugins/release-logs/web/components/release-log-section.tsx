import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactElement } from "react";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { LiveLogChannel } from "@plugins/primitives/plugins/log-channels/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  RELEASE_LOG_CHANNEL,
  releaseRunLogs,
  releaseRuns,
  type ReleaseLogLine,
} from "@plugins/release/core";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";

// Mono log body: intentional fixed code size + line-height (not on the typography scale).
const monoLogClass = textVariantClass("code");

export function ReleaseLogSection({ runId }: { runId: string }): ReactElement {
  const result = useLiveRow(releaseRuns, runId);

  // Live runs stream over `/ws/logs`; finished runs read the persisted log.
  // While the row is still loading we optimistically show the live stream
  // (an early return rather than collapsing it into a fake-empty default —
  // keeps "loading" distinct from "genuinely finished"). A failed read decides
  // from the row as last seen; never seen, it says so rather than guessing.
  switch (result.status) {
    case "loading":
      return <LiveLogs />;
    case "error":
      if (result.stale === undefined) {
        return (
          <ResourceErrorInline
            variant="block"
            subject="the release run"
            error={result.error}
            refetch={result.refetch}
          />
        );
      }
      return result.stale.status === "running" ? (
        <LiveLogs />
      ) : (
        <PersistedLogs runId={runId} />
      );
    case "ready":
      if (result.found && result.row.status === "running") return <LiveLogs />;
      return <PersistedLogs runId={runId} />;
  }
}

/**
 * The live half is the shared `LiveLogChannel` primitive. The WS subscribe, the
 * sequence de-dup, the sticky scroll and the copy button used to be a local copy
 * of the body the deploy panel and the debug viewer carry too.
 */
function LiveLogs(): ReactElement {
  const toast = useToast();
  return (
    <LiveLogChannel
      channel={RELEASE_LOG_CHANNEL}
      label="Logs"
      emptyState="No release logs yet"
      onError={(error) =>
        toast({
          type: "release",
          title: "Release log error",
          description: error,
          variant: "error",
        })
      }
    />
  );
}

function PersistedLogs({ runId }: { runId: string }): ReactElement {
  const result = useLive(releaseRunLogs, { id: runId });
  switch (result.status) {
    case "loading":
      return <Loading variant="rows" count={3} />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the release logs"
          error={result.error}
          refetch={result.refetch}
        />
      );
    case "ready":
      return <LogLines lines={result.data.lines} />;
  }
}

function LogLines({ lines }: { lines: ReleaseLogLine[] }): ReactElement {
  return (
    <Stack gap="xs">
      <Line className="pb-xs">
        <Fill>
          <Text as="span" variant="label" className="text-muted-foreground">
            Logs
          </Text>
        </Fill>
        <ControlSizeProvider size="xs">
          <CopyButton
            text={lines.map((l) => l.text).join("\n")}
            tooltip="Copy logs"
          />
        </ControlSizeProvider>
      </Line>
      <Scroll
        axis="y"
        className={`min-h-48 max-h-96 rounded-md border bg-muted/30 px-md py-sm ${monoLogClass}`}
      >
        {lines.length === 0 && (
          <span className="text-muted-foreground">No release logs</span>
        )}
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap break-all",
              line.stream === "stderr" ? "text-destructive" : "text-foreground",
            )}
          >
            {line.text}
          </div>
        ))}
      </Scroll>
    </Stack>
  );
}
