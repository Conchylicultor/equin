import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, type ReactElement } from "react";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  useLivePagedValuePaging,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  buildRunLogs,
  type BuildLogLine,
  type BuildLogStep,
  type BuildRunLogsMeta,
  type BuildRunLogsQuery,
  type BuildRunLogsRefusal,
} from "../../core";
import type { MachineFeature } from "@plugins/infra/plugins/endpoints/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");
const closeIcon = symbol("close");
const runningIcon = symbol("hourglass-empty");

// Markers scraped by codegen (data-views.generated.ts). Must live in web/**.
const BUILD_RUN_LOG_STEPS = defineDataView("build.run-log-steps");
const BUILD_RUN_LOG_LINES = defineDataView("build.run-logs");

const NO_LINES: BuildLogLine[] = [];

/** A step of the run's log, with its position — the id its lines name it by. */
interface IndexedStep extends BuildLogStep {
  index: number;
}

function durationText(step: BuildLogStep): string {
  return step.durationMs === null
    ? "—"
    : `${(step.durationMs / 1000).toFixed(1)}s`;
}

const STATUS_ICON = {
  ok: { icon: checkIcon, tone: "text-success" },
  failed: { icon: closeIcon, tone: "text-destructive" },
  running: { icon: runningIcon, tone: "text-muted-foreground" },
} as const;

/**
 * One build run's log: its transcript's steps and lines — every build writes
 * one from its first line, so a running build's log moves as it runs. A run
 * refused `missing` has none on disk any more (reaped by the prune, or a
 * hand-run build from before every build recorded one).
 */
export function BuildLogSection({ runId }: { runId: string }): ReactElement {
  const query = useMemo((): BuildRunLogsQuery => ({ id: runId }), [runId]);
  const meta = useLive(buildRunLogs.meta, query);
  switch (meta.status) {
    case "loading":
      return <Loading variant="rows" count={3} />;
    case "error":
      if (meta.error.kind === "refused" && meta.error.code === "missing") {
        return (
          <Placeholder tone="muted">
            This run's log is no longer on disk.
          </Placeholder>
        );
      }
      return (
        <ResourceErrorInline
          variant="block"
          subject="the build logs"
          error={meta.error}
          refetch={meta.refetch}
        />
      );
    case "ready":
      return <PersistedLogs query={query} meta={meta.data} />;
    // A host without the computer (the demo): there are no run files to read.
    case "unavailable":
      return <Placeholder tone="muted">{meta.message}</Placeholder>;
  }
}

/**
 * A run's persisted log: its steps (verdict, line count, duration), then its
 * lines newest first, a page at a time — the DataView pages them by viewport,
 * so scrolling down reads back through the log without the whole of it ever
 * being loaded.
 */
function PersistedLogs({
  query,
  meta,
}: {
  query: BuildRunLogsQuery;
  meta: BuildRunLogsMeta;
}): ReactElement {
  const steps = useMemo(
    (): IndexedStep[] => meta.steps.map((s, index) => ({ ...s, index })),
    [meta.steps],
  );
  const { pages, paging } = useLivePagedValuePaging<
    BuildLogLine,
    BuildRunLogsMeta,
    BuildRunLogsQuery,
    BuildRunLogsQuery,
    BuildRunLogsRefusal,
    MachineFeature
  >(buildRunLogs, query);
  const readiness = useMemo(() => {
    switch (pages.status) {
      case "ready":
        return { status: "ready" as const, data: pages.rows };
      case "loading":
      case "error":
        return pages;
      // Mounted only once the meta read is ready, which a host without the
      // computer never is — the two reads share the declaration's latch.
      case "unavailable":
        throw new Error(
          "build.run-logs: pages unavailable under a ready meta read",
        );
    }
  }, [pages]);
  const rows = pages.status === "ready" ? pages.rows : NO_LINES;

  const stepFields = useMemo<FieldDef<IndexedStep>[]>(
    () => [
      {
        id: "status",
        label: "Status",
        type: "text",
        header: false,
        width: "1.5rem",
        value: (s) => s.status,
        cell: (s) => (
          <Icon
            icon={STATUS_ICON[s.status].icon}
            className={cn("size-3.5", STATUS_ICON[s.status].tone, rigidClass())}
          />
        ),
      },
      {
        id: "label",
        label: "Step",
        type: "text",
        primary: true,
        width: "minmax(0,1fr)",
        value: (s) => s.label,
      },
      {
        id: "lines",
        label: "Lines",
        type: "number",
        width: "5rem",
        value: (s) => s.lines,
      },
      {
        id: "duration",
        label: "Duration",
        type: "number",
        width: "5rem",
        value: (s) => s.durationMs ?? 0,
        cell: (s) => (
          <Text variant="caption" tone="muted" className="tabular-nums">
            {durationText(s)}
          </Text>
        ),
      },
    ],
    [],
  );

  const lineFields = useMemo<FieldDef<BuildLogLine>[]>(
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
        id: "step",
        label: "Step",
        type: "text",
        value: (l) => steps[l.step]?.label ?? "",
        cell: (l) => {
          const step = steps[l.step];
          return (
            <Text
              variant="caption"
              tone={step?.status === "failed" ? "destructive" : "muted"}
              className="truncate"
            >
              {step?.label}
            </Text>
          );
        },
        width: "8rem",
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
    [steps],
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
          {/* The lines loaded so far, in run order — the reader pages the rest in. */}
          <CopyButton
            text={[...rows]
              .reverse()
              .map((l) => l.text)
              .join("\n")}
            tooltip="Copy the loaded lines"
          />
        </ControlSizeProvider>
      </Line>
      <DataView<IndexedStep>
        rows={steps}
        fields={stepFields}
        rowKey={(s) => String(s.index)}
        storageKey={BUILD_RUN_LOG_STEPS}
        views={["table"]}
        defaultView="table"
        emptyState="No steps"
      />
      <DataView<BuildLogLine>
        rows={rows}
        fields={lineFields}
        rowKey={(l) => l.n}
        storageKey={BUILD_RUN_LOG_LINES}
        recipe="log"
        views={["table", "list"]}
        defaultView="table"
        readiness={readiness}
        paging={paging ?? undefined}
        emptyState="No build logs"
      />
    </Stack>
  );
}
