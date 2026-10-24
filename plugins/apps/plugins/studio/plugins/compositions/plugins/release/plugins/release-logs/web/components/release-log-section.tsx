import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, type ReactElement } from "react";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  useLivePagedValuePaging,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { LiveLogChannel } from "@plugins/primitives/plugins/log-channels/web";
import {
  RELEASE_LOG_CHANNEL,
  releaseRunLogs,
  releaseRuns,
  type ReleaseLogLine,
  type ReleaseRunLogsQuery,
  type ReleaseRunLogsRefusal,
} from "@plugins/release/core";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const RELEASE_RUN_LOGS = defineDataView("release.run-logs");

const NO_LINES: ReleaseLogLine[] = [];

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

/**
 * A finished run's transcript, newest line first, a page at a time: the
 * DataView pages it by viewport, so scrolling down reads back through the log
 * (to its phase headers at line 1) without the whole file ever being loaded.
 */
function PersistedLogs({ runId }: { runId: string }): ReactElement {
  const { pages, paging } = useLivePagedValuePaging<
    ReleaseLogLine,
    undefined,
    ReleaseRunLogsQuery,
    ReleaseRunLogsQuery,
    ReleaseRunLogsRefusal
  >(releaseRunLogs, { id: runId });
  const readiness = useMemo(
    () =>
      pages.status === "ready"
        ? { status: "ready" as const, data: pages.rows }
        : pages,
    [pages],
  );
  const rows = pages.status === "ready" ? pages.rows : NO_LINES;

  const fields = useMemo<FieldDef<ReleaseLogLine>[]>(
    () => [
      {
        id: "n",
        label: "Line",
        type: "number",
        value: (l) => Number(l.n),
        cell: (l) => (
          <Text variant="code" tone="faint" className="tabular-nums">
            {Number(l.n)}
          </Text>
        ),
        width: "4rem",
      },
      {
        id: "text",
        label: "Text",
        type: "text",
        primary: true,
        value: (l) => l.text,
        cell: (l) => (
          <Text
            variant="code"
            tone={l.stream === "stderr" ? "destructive" : "default"}
            className="whitespace-pre-wrap break-all"
          >
            {l.text}
          </Text>
        ),
        width: "minmax(0,1fr)",
      },
    ],
    [],
  );

  return (
    <Stack gap="xs">
      <Line className="pb-xs">
        <Fill>
          <Text as="span" variant="label" className="text-muted-foreground">
            Logs
          </Text>
        </Fill>
        <ControlSizeProvider size="xs">
          {/* The lines loaded so far — the reader pages the rest in. */}
          <CopyButton
            text={[...rows]
              .reverse()
              .map((l) => l.text)
              .join("\n")}
            tooltip="Copy the loaded lines"
          />
        </ControlSizeProvider>
      </Line>
      <DataView<ReleaseLogLine>
        rows={rows}
        fields={fields}
        rowKey={(l) => l.n}
        storageKey={RELEASE_RUN_LOGS}
        views={["table", "list"]}
        defaultView="table"
        readiness={readiness}
        paging={paging ?? undefined}
        emptyState="No release logs"
      />
    </Stack>
  );
}
