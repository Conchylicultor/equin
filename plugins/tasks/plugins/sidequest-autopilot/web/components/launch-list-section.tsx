import { useMemo, useState, type ReactElement } from "react";
import { useConfigResult } from "@plugins/config_v2/web";
import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
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
import {
  taskDescriptions,
  taskRows,
} from "@plugins/tasks/plugins/tasks-core/core";
import { useStoredTracks } from "@plugins/tasks/plugins/task-track/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { patchTask } from "@plugins/tasks/web";
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
  sidequestAutopilotConfig,
  SIDEQUEST_AUTOPILOT_ID,
} from "../../shared/config";
import { answerTriageEndpoint, retriageEndpoint } from "../../shared/endpoints";
import {
  launchListRowKind,
  launchListRows,
  type LaunchListRow,
} from "../../shared/launch-list";
import {
  sidequestTriageRows,
  type SidequestTriage,
  type TriageRisk,
  type TriageVerdict,
} from "../../shared/triage";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const LAUNCH_LIST_VIEW = defineDataView(
  "tasks.sidequest-autopilot.launch-list",
);

// Stable (module-level), so the `select` re-runs only when the set changes:
// this automation's decisions, by task.
function ownDecisions(
  rows: readonly LaunchDecisionRow[],
): ReadonlyMap<string, LaunchDecision> {
  return new Map(
    rows
      .filter((r) => r.automationId === SIDEQUEST_AUTOPILOT_ID)
      .map((r) => [r.taskId, r.decision]),
  );
}

// Stable (module-level): the triage rows, by task.
function triageByTask(
  rows: readonly SidequestTriage[],
): ReadonlyMap<string, SidequestTriage> {
  return new Map(rows.map((r) => [r.taskId, r]));
}

const NO_ROWS: LaunchListRow[] = [];

// The title is the row's face; where it stands and the launch order are
// dimensions to group, filter and sort by, left out of the body.
const LAUNCH_LIST_OVERRIDES = fieldOverrides(launchListRowKind, {
  lane: { visible: false },
  rank: { visible: false },
});

const VERDICT_BADGE: Record<
  TriageVerdict,
  { label: string; variant: "success" | "warning" | "muted" }
> = {
  ready: { label: "Ready", variant: "success" },
  decide: { label: "Needs a decision", variant: "warning" },
  split: { label: "Too big — split", variant: "warning" },
  obsolete: { label: "Obsolete", variant: "muted" },
};

const RISK_VARIANT: Record<TriageRisk, "muted" | "warning" | "destructive"> = {
  low: "muted",
  medium: "warning",
  high: "destructive",
};

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
  const config = useConfigResult(sidequestAutopilotConfig);
  const catalog = useLive(automationsCatalog);
  const tracks = useStoredTracks();
  const tasks = useLive(taskRows);
  // Both read whole (`all`): the list joins them to every ready sidequest.
  const triage = useLive(sidequestTriageRows, { select: triageByTask });
  const decisions = useLive(launchDecisions, { select: ownDecisions });
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
  const descriptions = useLive(taskDescriptions, { ids: readyIds });
  const [now] = useState(() => new Date());
  // The person's own ticks, over triage's pre-ticks: `true` / `false` once
  // they clicked a row's box, absent until then.
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean>>(new Map());

  const result = useMemo(
    () =>
      combineResources({
        config,
        catalog,
        tracks,
        tasks,
        descriptions,
        triage,
        decisions,
      }),
    [config, catalog, tracks, tasks, descriptions, triage, decisions],
  );
  const rows = useMemo(
    () =>
      foldResource(result, {
        loading: () => NO_ROWS,
        error: () => NO_ROWS,
        // Never reaches the view: DataView renders the message instead.
        unavailable: () => NO_ROWS,
        ready: (d) => {
          const description = new Map(
            d.descriptions.map((r) => [r.id, r.description]),
          );
          const ready = d.tasks
            .filter((t) => t.status === "new" && d.tracks.has(t.id))
            .map((t) => ({
              id: t.id,
              title: t.title,
              description: description.get(t.id) ?? null,
              createdAt: new Date(t.createdAt),
            }));
          return launchListRows(
            ready,
            d.triage,
            d.decisions,
            now,
            d.config.staleAfterDays,
          );
        },
      }),
    [result, now],
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
  const t = row.triage;
  return (
    <>
      <Fill>
        <Stack gap="2xs">
          <Line>
            <Text variant="label">{row.task.title}</Text>
          </Line>
          {t !== null ? (
            <Line>
              <Text variant="caption" tone="muted">
                {[
                  t.areas.slice(0, 2).join(", "),
                  `~${formatMinutes(t.sizeMinutes)}`,
                  `value ${t.value}/5`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </Line>
          ) : null}
        </Stack>
      </Fill>
      <Stack direction="row" gap="xs" align="center" className={rigidClass()}>
        {t !== null && row.lane !== "proposed" && row.lane !== "approved" ? (
          <Badge variant={VERDICT_BADGE[t.verdict].variant}>
            {VERDICT_BADGE[t.verdict].label}
          </Badge>
        ) : null}
        {row.preTicked && row.lane === "proposed" ? (
          <Badge variant="info">Triage pick</Badge>
        ) : null}
        {row.staleness?.stale === true ? (
          <Badge variant="warning">
            {row.staleness.reason === "edited" ? "Stale — edited" : "Stale"}
          </Badge>
        ) : null}
        {t?.answer != null ? (
          <Badge variant="success">{`You: ${t.answer}`}</Badge>
        ) : null}
        {t !== null ? (
          <Badge variant={RISK_VARIANT[t.risk]}>{`risk: ${t.risk}`}</Badge>
        ) : null}
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
          onClick={stop(() => patchTask(row.task.id, { drop: true }))}
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
    case "triaging":
      return null;
  }
}

/** Triage's context, its question with one-click answers, and Re-triage. */
function RowDetail({ row }: { row: LaunchListRow }): ReactElement {
  const retriage = useEndpointMutation(retriageEndpoint);
  const answer = useEndpointMutation(answerTriageEndpoint);
  const t = row.triage;
  const rerun = () =>
    retriage
      .mutateAsync({ params: { taskId: row.task.id } })
      .then(() => undefined, swallowShown);
  if (t === null) {
    return (
      <Stack direction="row" gap="sm" align="center">
        <Fill>
          <Text variant="caption" tone="muted">
            Not read yet — triage reads one sidequest at a time.
          </Text>
        </Fill>
        <Button variant="outline" onClick={rerun}>
          Triage now
        </Button>
      </Stack>
    );
  }
  return (
    <Stack gap="sm">
      <Stack direction="row" gap="sm" align="center">
        <Fill>
          <Text variant="caption" tone="muted">
            {"Context written by triage "}
            <RelativeTime date={new Date(t.triagedAt)} />
            {` at ${t.mainSha.slice(0, 10)}`}
            {row.staleness?.stale === true
              ? row.staleness.reason === "edited"
                ? " — the task was edited since"
                : " — older than the stale-after setting"
              : ""}
          </Text>
        </Fill>
        <Button variant="ghost" onClick={rerun}>
          Re-triage
        </Button>
      </Stack>
      <Markdown>{t.context}</Markdown>
      {t.question !== null ? (
        <Stack gap="xs">
          <Text as="p" variant="label">
            {t.question}
          </Text>
          <Stack direction="row" gap="xs" wrap>
            {t.answers.map((label) => (
              <Button
                key={label}
                variant={t.answer === label ? "default" : "outline"}
                onClick={() =>
                  answer
                    .mutateAsync({
                      params: { taskId: row.task.id },
                      body: { answer: t.answer === label ? null : label },
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

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}
