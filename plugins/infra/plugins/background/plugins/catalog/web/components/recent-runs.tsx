import { useMemo, type ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  defineItemActions,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  backgroundCentralRecentRuns,
  backgroundRecentRuns,
  type BackgroundEntry,
  type BackgroundRecentRuns,
  type BackgroundRun,
} from "../../core";
import { ENTRY_STATUS_LABEL, runResultText } from "../internal/present";
import { EntryStatusDot } from "./entry-status-dot";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const RECENT_RUNS_VIEW = defineDataView("infra.background.recent-runs");

const NO_RUNS: BackgroundRun[] = [];

/** A recent run, with the entry it is a run of (what its row actions read). */
export interface EntryRun {
  entry: BackgroundEntry;
  run: BackgroundRun;
}

/**
 * The recent-runs list's row actions. The catalog contributes none: it is infra
 * every backend depends on, so an action reaching higher layers (an
 * Investigate filing a task) is contributed by the app that mounts the list.
 */
export const RecentRunActions = defineItemActions<EntryRun>();

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * An entry's recent runs, newest first, pushed live — read from the process
 * that runs it (this worktree backend, or central for a machine-wide entry).
 */
export function RecentRuns({
  entry,
}: {
  entry: BackgroundEntry;
}): ReactElement {
  return entry.scope === "central" ? (
    <CentralRecentRuns entry={entry} />
  ) : (
    <WorktreeRecentRuns entry={entry} />
  );
}

function WorktreeRecentRuns({ entry }: { entry: BackgroundEntry }) {
  const result = useLive(backgroundRecentRuns, {
    kind: entry.kind,
    name: entry.name,
  });
  return <RecentRunsList entry={entry} result={result} />;
}

function CentralRecentRuns({ entry }: { entry: BackgroundEntry }) {
  const result = useLive(backgroundCentralRecentRuns, {
    kind: entry.kind,
    name: entry.name,
  });
  // No central runtime behind this subtree (the demo).
  if (result.status === "unavailable")
    return <Placeholder>{result.message}</Placeholder>;
  return <RecentRunsList entry={entry} result={result} />;
}

// The heading IS the list's header: no toolbar band of its own (a band of
// search/filter over at most twenty rows is a strip that does nothing). The
// options trigger sits beside the heading, hover-revealed.
function RecentRunsFrame({ options, body }: HostedToolbarParts): ReactElement {
  return (
    <Stack gap="xs">
      <Stack direction="row" gap="sm" align="center">
        <Fill>
          <Text as="h3" variant="label" tone="muted">
            Recent runs
          </Text>
        </Fill>
        {options}
      </Stack>
      {body}
    </Stack>
  );
}

const RECENT_RUNS_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: RecentRunsFrame,
};

function RecentRunsList({
  entry,
  result,
}: {
  entry: BackgroundEntry;
  result: ResourceResult<BackgroundRecentRuns>;
}): ReactElement {
  const untracked = foldResource(result, {
    loading: () => false,
    error: () => false,
    ready: (d) => !d.tracked,
  });
  const runs = foldResource(result, {
    loading: () => NO_RUNS,
    error: () => NO_RUNS,
    ready: (d) => (d.tracked ? d.runs : NO_RUNS),
  });
  const rows = useMemo(
    () => runs.map((run): EntryRun => ({ entry, run })),
    [runs, entry],
  );

  const fields = useMemo<FieldDef<EntryRun>[]>(
    () => [
      {
        id: "startedAt",
        label: "Started",
        type: "date",
        primary: true,
        value: (r) => new Date(r.run.startedAt),
        sortable: true,
      },
      {
        id: "outcome",
        label: "Outcome",
        type: "enum",
        value: (r) => r.run.outcome,
        options: (["running", "succeeded", "failed", "suspended"] as const).map(
          (value) => ({ value, label: ENTRY_STATUS_LABEL[value] }),
        ),
        filterable: true,
        visible: false,
      },
    ],
    [],
  );

  if (untracked) {
    return (
      <Stack gap="xs">
        <Text as="h3" variant="label" tone="muted">
          Recent runs
        </Text>
        <Placeholder tone="muted">
          This kind of background work keeps no run history.
        </Placeholder>
      </Stack>
    );
  }
  return (
    <DataView<EntryRun>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.run.startedAt}
      itemActions={RecentRunActions}
      views={["list"]}
      storageKey={RECENT_RUNS_VIEW}
      readiness={result}
      density="compact"
      toolbar={RECENT_RUNS_TOOLBAR}
      viewOptions={{
        list: {
          leading: (r: EntryRun) => <EntryStatusDot status={r.run.outcome} />,
          renderRow: (r: EntryRun) => <RunRowBody run={r.run} />,
        },
      }}
      emptyState={
        entry.runsHere ? (
          <>No run recorded yet.</>
        ) : (
          <>This runs on main; its runs are recorded there.</>
        )
      }
    />
  );
}

function RunRowBody({ run }: { run: BackgroundRun }): ReactElement {
  const started = new Date(run.startedAt);
  return (
    <>
      <Fill>
        <Stack gap="none">
          <Line>
            <Text variant="caption">
              {WHEN.format(started)} · <RelativeTime date={started} />
            </Text>
          </Line>
          {run.error !== null ? (
            <Line>
              <Text variant="caption" tone="destructive">
                {run.error}
              </Text>
            </Line>
          ) : null}
        </Stack>
      </Fill>
      <Text
        variant="caption"
        tone={run.outcome === "failed" ? "destructive" : "muted"}
        className={`tabular-nums ${rigidClass()}`}
      >
        {run.outcome === "suspended" ? "handed off" : runResultText(run)}
      </Text>
    </>
  );
}
