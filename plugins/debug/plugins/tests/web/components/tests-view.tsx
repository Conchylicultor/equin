import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  runTestsNow,
  TEST_STATUSES,
  testDigestGeneration,
  testFileStatus,
  type DigestGeneration,
  type TestFileStatusRow,
  type TestStatus,
} from "../../core";
import {
  buildTestTree,
  countStatuses,
  type TestTreeRow,
} from "../internal/build-test-tree";
import { IdlePill } from "./idle-pill";
import {
  CountsBar,
  HistoryStrip,
  STATUS_META,
  TestStatusDot,
} from "./status-paint";

const TESTS_TREE_VIEW = defineDataView("debug.tests.tree");

const hierarchy: HierarchyConfig<TestTreeRow> = {
  getParentId: (r) => r.parentId,
  getRank: (r) => r.rank,
};

function shortSha(sha: string | null): string {
  return sha === null ? "?" : sha.slice(0, 9);
}

export interface TestsViewProps {
  /** The status the cards filter the tree by, or none. */
  status: TestStatus | undefined;
  onStatus: (status: TestStatus | undefined) => void;
  selectedPath: string | undefined;
  /** Where a file row goes: a link, so ⌘-click opens it in a browser tab. */
  linkTo: (path: string) => LinkTarget;
}

/**
 * Debug → Tests: every test file of this checkout with its last known status,
 * as summary cards (which double as the status filter) over a plugin tree.
 */
export function TestsView(props: TestsViewProps): ReactElement {
  const generation = useLive(testDigestGeneration);
  const files = useLive(testFileStatus);
  if (generation.status === "loading" || files.status === "loading")
    return <Loading variant="rows" />;
  if (generation.status === "error")
    return <ResourceErrorInline variant="block" error={generation.error} />;
  if (files.status === "error")
    return <ResourceErrorInline variant="block" error={files.error} />;
  const gen = generation.data;
  // Not known yet is a state: before the first digests land, no file has a
  // status to show.
  if (gen.generation === null) {
    if (gen.state === "failed")
      return (
        <Inset pad="lg">
          <Text tone="destructive">
            Computing this checkout's test digests failed: {gen.error}
          </Text>
        </Inset>
      );
    return (
      <Inset pad="lg">
        <Loading
          variant="spinner"
          label={`Computing test digests for this checkout${gen.headSha ? ` @ ${shortSha(gen.headSha)}` : ""}…`}
        />
      </Inset>
    );
  }
  return <TestsBody {...props} generation={gen} files={files.data} />;
}

function TestsBody({
  generation,
  files,
  status,
  onStatus,
  selectedPath,
  linkTo,
}: TestsViewProps & {
  generation: DigestGeneration;
  files: readonly TestFileStatusRow[];
}): ReactElement {
  const counts = useMemo(() => countStatuses(files), [files]);
  const shown = useMemo(
    () =>
      status === undefined ? files : files.filter((f) => f.status === status),
    [files, status],
  );
  const rows = useMemo(() => buildTestTree(shown), [shown]);
  const runNow = useEndpointMutation(runTestsNow);
  const run = async (paths: string[], what: string): Promise<void> => {
    if (runNow.kind === "unavailable") return;
    const { files: n } = await runNow.mutateAsync({ body: { paths } });
    showToast({
      title: `Running ${n} test file${n === 1 ? "" : "s"}`,
      description: `${what}: their verdicts appear here as the run finishes.`,
    });
  };
  const stalePaths = files
    .filter((f) => f.status === "stale" || f.status === "never")
    .map((f) => f.path);
  const verdicts = counts.failing + counts.flaky + counts.passing;

  return (
    <Stack gap="md">
      <Inset pad="md">
        <Stack gap="md">
          <Line>
            <Fill>
              <Stack gap="2xs">
                <Text variant="heading">
                  {files.length} test files @ {shortSha(generation.headSha)}
                </Text>
                <Text tone="muted" variant="caption">
                  {verdicts} with a verdict on the current code · digests of
                  tree {shortSha(generation.generation)}
                  {generation.computedAt !== null && (
                    <>
                      {" "}
                      computed{" "}
                      <RelativeTime date={new Date(generation.computedAt)} />
                    </>
                  )}
                  {generation.computingSince !== null &&
                    " · checking for changes…"}
                  {generation.state === "failed" &&
                    ` · the last recompute failed: ${generation.error}`}
                </Text>
              </Stack>
            </Fill>
            <IdlePill />
            {runNow.kind === "available" && (
              <Inline gap="xs">
                <Button
                  variant="outline"
                  disabled={stalePaths.length === 0}
                  onClick={() => run(stalePaths, "Stale and never-run files")}
                >
                  Run stale ({stalePaths.length})
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    run(
                      files.map((f) => f.path),
                      "Every test file",
                    )
                  }
                >
                  Run all
                </Button>
              </Inline>
            )}
          </Line>
          <SummaryCards
            counts={counts}
            total={files.length}
            status={status}
            onStatus={onStatus}
          />
        </Stack>
      </Inset>
      <DataView<TestTreeRow>
        rows={rows}
        fields={FIELDS}
        rowKey={(r) => r.id}
        views={["table"]}
        defaultView="tree"
        storageKey={TESTS_TREE_VIEW}
        hierarchy={hierarchy}
        selectedRowId={
          selectedPath === undefined ? undefined : `file:${selectedPath}`
        }
        rowActivation={(r) =>
          r.kind === "file" ? linkTo(r.file.path) : undefined
        }
        searchAccessor={(r) => r.searchText}
        emptyState={
          status === undefined ? (
            <>No test files in this checkout.</>
          ) : (
            <>No {STATUS_META[status].label.toLowerCase()} test files.</>
          )
        }
      />
    </Stack>
  );
}

function SummaryCards({
  counts,
  total,
  status,
  onStatus,
}: {
  counts: Record<TestStatus, number>;
  total: number;
  status: TestStatus | undefined;
  onStatus: (s: TestStatus | undefined) => void;
}): ReactElement {
  return (
    <Stack gap="sm">
      <Grid cols={TEST_STATUSES.length} gap="sm">
        {TEST_STATUSES.map((s) => (
          <Card
            key={s}
            as="button"
            interactive
            selected={status === s}
            title={STATUS_META[s].description}
            onClick={() => onStatus(status === s ? undefined : s)}
          >
            <Inset pad="sm">
              <Stack gap="2xs">
                <Inline gap="xs">
                  <TestStatusDot status={s} lastOutcome={null} />
                  <Text variant="label">{STATUS_META[s].label}</Text>
                </Inline>
                <Text variant="title">{counts[s]}</Text>
                <Text tone="muted" variant="caption">
                  {total === 0 ? "0" : ((counts[s] / total) * 100).toFixed(1)}%
                  of files
                </Text>
              </Stack>
            </Inset>
          </Card>
        ))}
      </Grid>
      <CountsBar counts={counts} total={total} wide />
    </Stack>
  );
}

const FIELDS: FieldDef<TestTreeRow>[] = [
  {
    id: "name",
    label: "Name",
    primary: true,
    value: (r) => r.name,
    cell: (r) => (
      <Inline gap="xs">
        {r.kind === "file" ? (
          <TestStatusDot status={r.status} lastOutcome={r.file.lastOutcome} />
        ) : (
          <TestStatusDot status={r.status} lastOutcome={null} />
        )}
        <Text variant={r.kind === "file" ? "code" : "label"}>{r.name}</Text>
      </Inline>
    ),
  },
  {
    id: "status",
    label: "Status",
    type: "text",
    value: (r) => STATUS_META[r.status].label,
    visible: false,
  },
  {
    id: "runner",
    label: "Runner",
    type: "text",
    value: (r) =>
      r.kind === "file" ? (r.file.runner === "vitest" ? "jsdom" : "bun") : "",
    width: "4rem",
  },
  {
    id: "cases",
    label: "Cases",
    type: "text",
    sortable: false,
    value: (r) =>
      r.kind === "file"
        ? r.file.cases === null
          ? ""
          : `${r.file.failedCases ?? 0}/${r.file.cases}`
        : `${r.fileCount} files`,
    cell: (r) =>
      r.kind === "plugin" ? (
        <Inline gap="xs">
          <CountsBar counts={r.counts} total={r.fileCount} />
          <Text tone="muted" variant="caption">
            {r.counts.failing + r.counts.flaky > 0
              ? `${r.counts.failing + r.counts.flaky}/${r.fileCount}`
              : r.fileCount}
          </Text>
        </Inline>
      ) : r.file.cases === null ? null : (
        <Text
          variant="caption"
          tone={(r.file.failedCases ?? 0) > 0 ? "destructive" : "muted"}
        >
          {r.file.failedCases ?? 0}/{r.file.cases}
        </Text>
      ),
    width: "8rem",
  },
  {
    id: "duration",
    label: "Duration",
    type: "number",
    value: (r) => (r.kind === "file" ? (r.file.durationMs ?? 0) : 0),
    cell: (r) =>
      r.kind === "file" && r.file.durationMs !== null ? (
        <Text tone="muted" variant="caption" className="tabular-nums">
          {formatDuration(r.file.durationMs)}
        </Text>
      ) : null,
    width: "5rem",
  },
  {
    id: "history",
    label: "History",
    type: "text",
    sortable: false,
    filterable: false,
    value: () => "",
    cell: (r) =>
      r.kind === "file" ? <HistoryStrip history={r.file.history} /> : null,
    width: "6rem",
  },
  {
    id: "ran",
    label: "Ran",
    type: "date",
    value: (r) => (r.kind === "file" ? r.file.lastRanAt : null),
    cell: (r) =>
      r.kind === "file" && r.file.lastRanAt !== null ? (
        <Text tone="muted" variant="caption">
          <RelativeTime date={r.file.lastRanAt} />
        </Text>
      ) : null,
    width: "6rem",
  },
];
