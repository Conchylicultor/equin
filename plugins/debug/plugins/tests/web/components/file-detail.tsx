import { useMemo, type ReactElement } from "react";
import { useLive, rowOrStale } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { InvestigateAction } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  runTestsNow,
  TESTS_CATEGORY_ID,
  testCaseFailures,
  testFileRuns,
  testFileStatus,
  testFileSubject,
  type TestCaseFailureRow,
  type TestFileRunRow,
  type TestFileStatusRow,
} from "../../core";
import { STATUS_META, TestStatusDot } from "./status-paint";
import { testFileBrief } from "../internal/investigate";

const RUNS_VIEW = defineDataView("debug.tests.file-runs");

const runsSource = liveDataSource(testFileRuns, {
  surface: RUNS_VIEW,
  searchable: ["slug"],
  unscoped: {
    reason:
      "one file's recorded results, a few dozen at most: custom columns would sort and filter nothing worth a scope",
  },
});

const ORIGIN_LABEL = {
  agent: "agent",
  "run-now": "Run now",
  idle: "idle run",
} as const;

/** One test file: its status, last run, failing cases and recent runs. */
export function FileDetail({ path }: { path: string }): ReactElement {
  const row = rowOrStale(useLive(testFileStatus, { id: path }));
  // The pane's resolve guard answered found; a row read pending again (a
  // reconnect) keeps the stale row, so `undefined` is only a first render.
  if (row === undefined) return <Loading variant="rows" />;
  return <FileDetailBody file={row} />;
}

function FileDetailBody({ file }: { file: TestFileStatusRow }): ReactElement {
  const meta = STATUS_META[file.status];
  const runNow = useEndpointMutation(runTestsNow);
  // The newest run on the current code that did not pass: its failing cases.
  const failingRun = file.history.find(
    (h) => h.current && h.outcome !== "passed",
  );
  const investigable = file.status === "failing" || file.status === "flaky";
  // Whether each run ran the file's current code: the page's matching rule,
  // shown per run.
  const runFields = useMemo<FieldDef<TestFileRunRow>[]>(
    () => [
      {
        id: "code",
        label: "Code",
        type: "text",
        value: (r) => (r.digest === file.digest ? "current" : "older"),
        cell: (r) =>
          r.digest === file.digest ? (
            <Text variant="caption">current</Text>
          ) : (
            <Text tone="faint" variant="caption">
              older
            </Text>
          ),
        sortable: false,
        filterable: false,
        width: "5rem",
      },
    ],
    [file.digest],
  );
  return (
    <Inset pad="md">
      <Stack gap="md">
        <Stack gap="xs">
          <Inline gap="xs">
            <TestStatusDot
              status={file.status}
              lastOutcome={file.lastOutcome}
            />
            <Text variant="heading">{meta.label}</Text>
            <Text tone="muted">— {meta.description}</Text>
          </Inline>
          <Text variant="code">{file.path}</Text>
          <Inline gap="sm">
            <Badge variant="muted">
              {file.runner === "vitest" ? "jsdom (vitest)" : "bun:test"}
            </Badge>
            {file.cases !== null && (
              <Text tone="muted" variant="caption">
                {file.failedCases ?? 0} of {file.cases} cases failed
              </Text>
            )}
            {file.durationMs !== null && (
              <Text tone="muted" variant="caption">
                {formatDuration(file.durationMs)}
              </Text>
            )}
            <Text tone="faint" variant="caption" title={file.digest}>
              digest {file.digest.slice(0, 10)}
            </Text>
          </Inline>
          {file.lastRanAt !== null && (
            <Text tone="muted" variant="caption">
              Last ran <RelativeTime date={file.lastRanAt} /> by{" "}
              {file.lastOrigin === null ? "?" : ORIGIN_LABEL[file.lastOrigin]}
              {file.lastSlug !== null && ` in ${file.lastSlug}`}
              {file.status === "stale" && " — on older code"}
            </Text>
          )}
        </Stack>
        <Inline gap="xs">
          {runNow.kind === "available" && (
            <Button
              variant="outline"
              onClick={async () => {
                await runNow.mutateAsync({ body: { paths: [file.path] } });
                showToast({
                  title: "Running 1 test file",
                  description: `${file.path}: its verdict appears here when the run finishes.`,
                });
              }}
            >
              Run now
            </Button>
          )}
          {investigable && (
            <InvestigateAction
              presentation="button"
              noun="test"
              subject={testFileSubject(file.path)}
              categoryId={TESTS_CATEGORY_ID}
              description="Launch an agent to find out why this test file fails and fix it."
              placeholder="Extra context (optional)…"
              brief={(userText) => testFileBrief(file, userText)}
            />
          )}
        </Inline>
        {file.status === "flaky" && (
          <Card>
            <Inset pad="sm">
              <Text>
                On the current code it passed {file.currentPassed}× and failed{" "}
                {file.currentFailed}× (
                {[
                  ...new Set(
                    file.history
                      .filter((h) => h.current)
                      .map((h) => `${h.outcome} by ${ORIGIN_LABEL[h.origin]}`),
                  ),
                ].join(", ")}
                ). A verdict the digest cannot see — a fixture on disk, the
                environment, timing — can also split runs.
              </Text>
            </Inset>
          </Card>
        )}
        {failingRun !== undefined && (
          <FailingCases opId={failingRun.opId} path={file.path} />
        )}
        <Stack gap="xs">
          <Text variant="subheading">Recent runs</Text>
          <DataView<TestFileRunRow>
            overrides={runOverrides}
            extraFields={runFields}
            recipe="ledger"
            views={["table"]}
            defaultView="recent"
            emptyState={<>No recorded run of this file.</>}
            source={runsSource.scoped({ where: { path: file.path } })}
          />
        </Stack>
      </Stack>
    </Inset>
  );
}

function FailingCases({
  opId,
  path,
}: {
  opId: string;
  path: string;
}): ReactElement {
  const failures = useLive(testCaseFailures, { where: { opId, path } });
  return (
    <Stack gap="xs">
      <Text variant="subheading">Failing cases</Text>
      {failures.status === "loading" ? (
        <Loading variant="rows" count={2} />
      ) : failures.status === "error" ? (
        <ResourceErrorInline variant="block" error={failures.error} />
      ) : failures.data.length === 0 ? (
        <Text tone="muted">
          No failing case was recorded — the file did not load, or its runner
          failed outside any case.
        </Text>
      ) : (
        <Stack gap="sm">
          {failures.data.map((f) => (
            <FailureCard key={f.id} failure={f} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function FailureCard({
  failure,
}: {
  failure: TestCaseFailureRow;
}): ReactElement {
  return (
    <Card>
      <Inset pad="sm">
        <Stack gap="xs">
          <Text variant="label">{failure.caseId}</Text>
          <Text tone="destructive" variant="code">
            {failure.message}
          </Text>
          {failure.detail !== "" && failure.detail !== failure.message && (
            <Text variant="code" tone="muted" className="whitespace-pre-wrap">
              {failure.detail}
            </Text>
          )}
        </Stack>
      </Inset>
    </Card>
  );
}

const runOverrides = fieldOverrides(testFileRuns, {
  path: { visible: false },
  runner: { visible: false },
  finishedAt: {
    cell: (r) => (
      <Text tone="muted" title={r.finishedAt.toLocaleString()}>
        <RelativeTime date={r.finishedAt} />
      </Text>
    ),
  },
});
