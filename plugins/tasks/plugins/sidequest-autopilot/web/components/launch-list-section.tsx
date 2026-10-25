import { useMemo, useState, type ReactElement } from "react";
import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
  mapResource,
} from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type { FieldOptionMeta } from "@plugins/fields/core";
import { taskRows } from "@plugins/tasks/plugins/tasks-core/core";
import { useStoredTracks } from "@plugins/tasks/plugins/task-track/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { patchTask } from "@plugins/tasks/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  automationsCatalog,
  decideLaunchEndpoint,
  launchDecisions,
  MAX_DECIDED_TASKS,
  type AutomationEntry,
  type LaunchDecision,
  type LaunchDecisionRow,
} from "@plugins/tasks/plugins/automations/core";
import {
  answerTriageEndpoint,
  parseTriageRead,
  runTriageEndpoint,
  TRIAGE_PRIORITY_META,
  TRIAGE_RISK_META,
  TRIAGE_STALE_REASON_META,
  TRIAGE_STATE_META,
  TRIAGE_TASK_TYPE_META,
  TRIAGE_VERDICT_META,
  taskTriageReads,
  type TaskTriageRow,
  type TriageRead,
} from "@plugins/tasks/plugins/task-triage/core";
import { SIDEQUEST_AUTOPILOT_ID } from "../../shared/config";
import {
  launchListRowKind,
  launchListRows,
  type LaunchListRow,
} from "../../shared/launch-list";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const LAUNCH_LIST_VIEW = defineDataView(
  "tasks.sidequest-autopilot.launch-list",
);

// Stable (module-level), so the `select` re-runs only when the set changes:
// every task's decision (a decision is the task's, whichever automation — or
// the task itself — it was made from), by task.
function decisionsByTask(
  rows: readonly LaunchDecisionRow[],
): ReadonlyMap<string, LaunchDecision> {
  return new Map(rows.map((r) => [r.taskId, r.decision]));
}

// The triage rows, parsed (a row breaking its state contract throws), by task.
function triageByTask(
  rows: readonly TaskTriageRow[],
): ReadonlyMap<string, TriageRead> {
  return new Map(rows.map((r) => [r.taskId, parseTriageRead(r)]));
}

const NO_ROWS: LaunchListRow[] = [];

// The title is the row's face; where it stands and the launch order are
// dimensions to group, filter and sort by, left out of the body.
const LAUNCH_LIST_OVERRIDES = fieldOverrides(launchListRowKind, {
  lane: { visible: false },
  rank: { visible: false },
});

/** One of task-triage's option chips, as every triage surface draws it. */
function MetaBadge({ meta }: { meta: FieldOptionMeta }): ReactElement {
  return (
    <Badge variant={meta.variant ?? "muted"} tooltip={meta.hint}>
      {meta.label}
    </Badge>
  );
}

type LaunchEntry = Extract<AutomationEntry, { kind: "launch" }>;

function LaunchListFrame({ options, body }: HostedToolbarParts): ReactElement {
  return (
    <Stack gap="xs">
      <Stack direction="row" gap="sm" align="center">
        <Fill>
          <Text as="h3" variant="eyebrow" tone="muted">
            Launch list
          </Text>
        </Fill>
        {options}
      </Stack>
      {body}
    </Stack>
  );
}

const LAUNCH_LIST_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: LaunchListFrame,
};

/**
 * The launch list: every ready sidequest, in launch order, grouped by where it
 * stands — approved, proposed by triage, waiting on the person's call, looks
 * obsolete, still being read, excluded. ONLY the Approved group ever launches:
 * triage may tick a proposed row for the person, but nothing is approved until
 * they press Approve.
 */
export function LaunchListSection(): ReactElement {
  const openPane = useOpenPane();
  const catalog = useLive(automationsCatalog);
  const tracks = useStoredTracks();
  const tasks = useLive(taskRows);
  // Read whole (`all`): the list joins it to every ready sidequest.
  const decisions = useLive(launchDecisions, { select: decisionsByTask });
  const readyIds = useMemo(
    () =>
      foldResource(combineResources({ tracks, tasks }), {
        loading: () => [],
        error: () => [],
        ready: (d) =>
          d.tasks
            .filter((t) => t.status === "new" && d.tracks.has(t.id))
            .map((t) => t.id),
      }),
    [tracks, tasks],
  );
  // The triage of exactly the sidequests shown — a point read by id.
  const triageRows = useLive(taskTriageReads, { ids: readyIds });
  const triage = useMemo(
    () => mapResource(triageRows, triageByTask),
    [triageRows],
  );
  // The person's own ticks, over triage's pre-ticks: `true` / `false` once
  // they clicked a row's box, absent until then.
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean>>(new Map());

  const result = useMemo(
    () => combineResources({ catalog, tracks, tasks, triage, decisions }),
    [catalog, tracks, tasks, triage, decisions],
  );
  const rows = useMemo(
    () =>
      foldResource(result, {
        loading: () => NO_ROWS,
        error: () => NO_ROWS,
        // Never reaches the view: DataView renders the message instead.
        unavailable: () => NO_ROWS,
        ready: (d) => {
          const ready = d.tasks
            .filter((t) => t.status === "new" && d.tracks.has(t.id))
            .map((t) => ({
              id: t.id,
              title: t.title,
              createdAt: new Date(t.createdAt),
            }));
          return launchListRows(ready, d.triage, d.decisions);
        },
      }),
    [result],
  );
  const entry = foldResource(catalog, {
    loading: () => null,
    error: () => null,
    unavailable: () => null,
    ready: (entries) =>
      entries.find(
        (e): e is LaunchEntry =>
          e.id === SIDEQUEST_AUTOPILOT_ID && e.kind === "launch",
      ) ?? null,
  });

  const ticked = (row: LaunchListRow): boolean =>
    ticks.get(row.task.id) ?? row.preTicked;
  const toggle = (row: LaunchListRow) =>
    setTicks(new Map(ticks).set(row.task.id, !ticked(row)));
  const selected = rows.filter(
    (r) => (r.lane === "proposed" || r.lane === "obsolete") && ticked(r),
  );

  return (
    <Stack gap="sm">
      {entry !== null ? (
        <LaunchListHeader
          entry={entry}
          approved={rows.filter((r) => r.lane === "approved").length}
          selected={selected}
          onApproved={() => setTicks(new Map())}
        />
      ) : null}
      <DataView<LaunchListRow>
        // Device-local view: a section of the automation's detail, beside its run history, which owns the pane's ;view.
        viewParam={false}
        rows={rows}
        collection={launchListRowKind}
        overrides={LAUNCH_LIST_OVERRIDES}
        rowKey={(r) => r.id}
        views={["list"]}
        storageKey={LAUNCH_LIST_VIEW}
        readiness={result}
        toolbar={LAUNCH_LIST_TOOLBAR}
        rowActivation={(r) =>
          openPane.to(taskDetailPane, { taskId: r.task.id }, { mode: "push" })
        }
        searchAccessor={(r) => r.task.title}
        searchPlaceholder="Search the sidequests…"
        viewOptions={{
          list: {
            leading: (r: LaunchListRow) => (
              <RowLead row={r} ticked={ticked(r)} onToggle={() => toggle(r)} />
            ),
            renderRow: (r: LaunchListRow) => <RowBody row={r} />,
            detail: (r: LaunchListRow) => <RowDetail row={r} />,
          },
        }}
        emptyState={<>No sidequest is ready to start.</>}
      />
    </Stack>
  );
}

/**
 * What will happen once it is on — how many of the approved it launches, how
 * many at a time — and the one button that approves: Approve selected.
 */
function LaunchListHeader({
  entry,
  approved,
  selected,
  onApproved,
}: {
  entry: LaunchEntry;
  approved: number;
  selected: readonly LaunchListRow[];
  onApproved: () => void;
}): ReactElement {
  const decide = useEndpointMutation(decideLaunchEndpoint);
  const left = Math.max(0, entry.maxLaunches - entry.launchedInBatch);
  const next = Math.min(left, approved);
  const words =
    approved === 0
      ? "Nothing approved — turned on, it launches nothing. Tick sidequests below and press Approve."
      : `${approved} approved. ${entry.enabled ? `${entry.launchedInBatch} of ${entry.maxLaunches} launched; it` : "Turned on, it"} launches the next ${next} best first, ${entry.concurrency} at a time${next < approved ? `; the other ${approved - next} wait for the next batch` : ""} — then it turns itself off.`;
  const approve = () =>
    decide
      .mutateAsync({
        params: { automationId: SIDEQUEST_AUTOPILOT_ID },
        body: {
          taskIds: selected.slice(0, MAX_DECIDED_TASKS).map((r) => r.task.id),
          decision: "approved",
        },
      })
      .then(onApproved, swallowShown);
  return (
    <Stack direction="row" gap="md" align="center">
      <Fill>
        <Text variant="caption" tone="muted">
          {words}
        </Text>
      </Fill>
      <Button
        variant="default"
        disabled={selected.length === 0}
        onClick={approve}
        className={rigidClass()}
      >
        {`Approve selected (${selected.length})`}
      </Button>
    </Stack>
  );
}

/** A failed request is already toasted by the endpoint layer; anything else stays loud. */
function swallowShown(err: unknown): void {
  if (err instanceof EndpointError) return;
  throw err;
}

/** The rank of an approved row; the box of a row the person may tick. */
function RowLead({
  row,
  ticked,
  onToggle,
}: {
  row: LaunchListRow;
  ticked: boolean;
  onToggle: () => void;
}): ReactElement | null {
  if (row.lane === "approved") {
    return (
      <Text variant="caption" tone="muted">
        {`#${row.rank}`}
      </Text>
    );
  }
  if (row.lane !== "proposed" && row.lane !== "obsolete") return null;
  return (
    <Button
      variant="ghost"
      aria-pressed={ticked}
      aria-label={ticked ? "Untick" : "Tick to approve"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <CheckboxIndicator checked={ticked} />
    </Button>
  );
}

function RowBody({ row }: { row: LaunchListRow }): ReactElement {
  const decide = useEndpointMutation(decideLaunchEndpoint);
  const setDecision = (decision: LaunchDecision | null) =>
    decide
      .mutateAsync({
        params: { automationId: SIDEQUEST_AUTOPILOT_ID },
        body: { taskIds: [row.task.id], decision },
      })
      .then(() => undefined, swallowShown);
  const r = row.result;
  const triage = row.triage;
  return (
    <>
      <Fill>
        <Stack gap="2xs">
          <Line>
            <Text variant="label">{row.task.title}</Text>
          </Line>
          {r !== null ? (
            <Stack direction="row" gap="xs" align="center">
              <MetaBadge meta={TRIAGE_PRIORITY_META[r.priority]} />
              <MetaBadge meta={TRIAGE_TASK_TYPE_META[r.taskType]} />
              {r.areas.length > 0 ? (
                <Line>
                  <Text variant="caption" tone="muted">
                    {r.areas.slice(0, 2).join(", ")}
                  </Text>
                </Line>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      </Fill>
      <Stack direction="row" gap="xs" align="center" className={rigidClass()}>
        {r !== null && row.lane !== "proposed" && row.lane !== "approved" ? (
          <MetaBadge meta={TRIAGE_VERDICT_META[r.verdict]} />
        ) : null}
        {row.preTicked && row.lane === "proposed" ? (
          <Badge variant="info">Triage pick</Badge>
        ) : null}
        {triage?.state === "stale" ? (
          <Badge
            variant="warning"
            tooltip={TRIAGE_STALE_REASON_META[triage.staleReason].hint}
          >
            {triage.staleReason === "edited" ? "Stale — edited" : "Stale"}
          </Badge>
        ) : null}
        {triage?.state === "queued" || triage?.state === "running" ? (
          <MetaBadge meta={TRIAGE_STATE_META[triage.state]} />
        ) : null}
        {r?.answer != null ? (
          <Badge variant="success">{`You: ${r.answer}`}</Badge>
        ) : null}
        {r !== null ? <MetaBadge meta={TRIAGE_RISK_META[r.risk]} /> : null}
        <RowAction row={row} setDecision={setDecision} />
      </Stack>
    </>
  );
}

function RowAction({
  row,
  setDecision,
}: {
  row: LaunchListRow;
  setDecision: (decision: LaunchDecision | null) => Promise<void>;
}): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  const stop =
    (run: () => Promise<void>) => (e: { stopPropagation(): void }) => {
      e.stopPropagation();
      return run();
    };
  switch (row.lane) {
    case "approved":
      return (
        <Button variant="ghost" onClick={stop(() => setDecision(null))}>
          Remove
        </Button>
      );
    case "excluded":
      return (
        <Button variant="ghost" onClick={stop(() => setDecision(null))}>
          Restore
        </Button>
      );
    case "obsolete":
      return (
        <Button
          variant="ghost"
          onClick={stop(() =>
            patchTask(fetchEndpoint, row.task.id, { drop: true }),
          )}
        >
          Drop task
        </Button>
      );
    case "proposed":
    case "needs-call":
      return (
        <Button variant="ghost" onClick={stop(() => setDecision("excluded"))}>
          Exclude
        </Button>
      );
    case "failed":
    case "triaging":
      return null;
  }
}

/**
 * Triage's context, its question with one-click answers, and Re-triage —
 * task-triage's run endpoint, the same request the task's Triage card makes.
 */
function RowDetail({ row }: { row: LaunchListRow }): ReactElement {
  const run = useEndpointMutation(runTriageEndpoint);
  const answer = useEndpointMutation(answerTriageEndpoint);
  const triage = row.triage;
  const r = row.result;
  const rerun = () =>
    run
      .mutateAsync({ params: { taskId: row.task.id } })
      .then(() => undefined, swallowShown);
  const inFlight = triage?.state === "queued" || triage?.state === "running";
  if (r === null) {
    return (
      <Stack direction="row" gap="sm" align="center">
        <Fill>
          <Text variant="caption" tone="muted">
            {triage === null
              ? "Not triaged yet."
              : triage.state === "failed"
                ? `Triage failed: ${triage.error}`
                : triage.state === "queued"
                  ? "Queued — triage reads a few tasks at a time."
                  : "Being read now."}
          </Text>
        </Fill>
        {inFlight ? null : (
          <Button variant="outline" onClick={rerun}>
            {triage === null ? "Triage now" : "Re-run"}
          </Button>
        )}
      </Stack>
    );
  }
  return (
    <Stack gap="sm">
      <Stack direction="row" gap="sm" align="center">
        <Fill>
          <Text variant="caption" tone="muted">
            {"Context written by triage "}
            <RelativeTime date={r.triagedAt} />
            {` at ${r.mainSha.slice(0, 10)}`}
            {triage?.state === "stale"
              ? ` — ${TRIAGE_STALE_REASON_META[triage.staleReason].hint}`
              : triage?.state === "failed"
                ? ` — the latest re-run failed: ${triage.error}`
                : inFlight
                  ? " — a new read is on its way"
                  : ""}
          </Text>
        </Fill>
        {inFlight ? null : (
          <Button variant="ghost" onClick={rerun}>
            Re-triage
          </Button>
        )}
      </Stack>
      <Markdown>{r.context}</Markdown>
      {r.question !== null ? (
        <Stack gap="xs">
          <Text as="p" variant="label">
            {r.question}
          </Text>
          <Stack direction="row" gap="xs" wrap>
            {r.answers.map((label) => (
              <Button
                key={label}
                variant={r.answer === label ? "default" : "outline"}
                onClick={() =>
                  answer
                    .mutateAsync({
                      params: { taskId: row.task.id },
                      body: { answer: r.answer === label ? null : label },
                    })
                    .then(() => undefined, swallowShown)
                }
              >
                {label}
              </Button>
            ))}
          </Stack>
          <Text variant="caption" tone="muted">
            Your answer goes to the agent. It approves nothing — tick the row
            and press Approve for that.
          </Text>
        </Stack>
      ) : null}
    </Stack>
  );
}
