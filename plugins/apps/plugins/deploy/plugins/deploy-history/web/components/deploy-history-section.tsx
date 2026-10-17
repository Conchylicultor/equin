import { useMemo, type ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  deployRunHistory,
  type DeployRunRecord,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { DeployRunItemActions } from "../slots";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
// It IS `deployRunHistory`'s column scope (asserted at mount): the surface
// whose custom columns sort and filter the live window.
const DEPLOY_HISTORY_VIEW = defineDataView("deploy.deployment.history");

/**
 * The live source. "Which deploy shipped a1b2c3d" and "which one printed that
 * error" are the two things anyone reaches for, so the search box matches the
 * release, the commit and the message.
 */
const deployHistorySource = liveDataSource(deployRunHistory, {
  searchable: ["releaseRunId", "commitSha", "message"],
});

function outcomeBadge(run: DeployRunRecord): ReactNode {
  if (run.status === "running") {
    return (
      <Badge
        variant="warning"
        icon={<StatusDot colorClass="bg-warning animate-pulse" />}
      >
        Running
      </Badge>
    );
  }
  if (run.status === "succeeded") {
    return (
      <Badge variant="success" icon={<StatusDot colorClass="bg-success" />}>
        Succeeded
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      icon={<StatusDot colorClass="bg-destructive" />}
    >
      {/* The leg names the failure when there is one: "failed on build" is a
          different fact from "failed on ship", and it is free to say. */}
      {run.phaseFailed ? `Failed on ${run.phaseFailed}` : "Failed"}
    </Badge>
  );
}

/**
 * Wall-clock time a run took, or how long the one in flight has been going.
 *
 * Local because the three formatters in the repo are all plugin-private to debug
 * surfaces; a shared `formatDuration` primitive would retire all four.
 */
function durationLabel(run: DeployRunRecord): string {
  const end = run.finishedAt ?? new Date();
  const ms = end.getTime() - run.startedAt.getTime();
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The first 7 chars of a sha — what git itself abbreviates to. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// What the list says of the fields it DERIVES from `deployRunHistory` (the
// run record's own: label, type, options, filter domain — a live window, so
// nothing here may be derived from what happens to be loaded): how each cell
// reads and how wide it is. `deploymentId` is the scope every window states,
// `finishedAt` only sorts and filters — neither is a column.
const overrides = fieldOverrides(deployRunHistory, {
  status: { cell: (r) => outcomeBadge(r), width: "12rem" },
  verb: {
    cell: (r) => <Badge variant="muted">{r.verb}</Badge>,
    width: "8rem",
  },
  commitSha: {
    cell: (r) =>
      r.commitSha ? (
        <span className="font-mono text-muted-foreground" title={r.commitSha}>
          {shortSha(r.commitSha)}
        </span>
      ) : null,
    width: "8rem",
  },
  releaseRunId: {
    cell: (r) =>
      r.releaseRunId ? (
        <span className="font-mono text-muted-foreground">
          {r.releaseRunId}
        </span>
      ) : null,
    width: "16rem",
  },
  startedAt: {
    cell: (r) => (
      <span className="text-muted-foreground">
        <RelativeTime date={r.startedAt} />
      </span>
    ),
    width: "8rem",
  },
  message: {
    cell: (r) =>
      r.message ? (
        <span className="whitespace-pre-wrap" title={r.message}>
          {r.message}
        </span>
      ) : null,
    width: "24rem",
  },
  deploymentId: { visible: false, filterable: false, groupable: false },
  finishedAt: { visible: false },
});

// The one field the list computes itself: `duration` has no column for the
// server to sort or filter, so it is neither (a live source offers a field
// only where its id or `column` names one).
const extraFields: FieldDef<DeployRunRecord>[] = [
  {
    id: "duration",
    label: "Took",
    type: "text",
    value: (r) => durationLabel(r),
    cell: (r) => (
      <span className="text-muted-foreground">{durationLabel(r)}</span>
    ),
    width: "6rem",
  },
];

/**
 * **History** — every run ever launched for this deployment, from the durable
 * `deploy_runs` ledger.
 *
 * This is the section that makes *"what is live on this box, and what happened
 * before"* answerable after a reboot. The `deploy.runs` resource the sections
 * above render from is in-memory and empty after a restart — deliberately, it is
 * the live view — and this is the record beside it. So the pane no longer has to
 * caveat that it forgets.
 *
 * A live window over the ledger (`deployRunHistory`), scoped to this
 * deployment: a run opening, finishing or failing moves its row in place, and
 * the scroll pages past one window with no cap.
 */
export function DeployHistorySection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  // This deployment's runs: its scope, stated as data (never a filter the
  // user's Filter control could name or widen).
  const source = useMemo(
    () => deployHistorySource.scoped({ where: { deploymentId } }),
    [deploymentId],
  );

  return (
    <DataView<DeployRunRecord>
      storageKey={DEPLOY_HISTORY_VIEW}
      overrides={overrides}
      extraFields={extraFields}
      views={["list", "table"]}
      defaultView="list"
      viewOptions={{
        list: { renderRow: (r: DeployRunRecord) => <HistoryRow run={r} /> },
      }}
      itemActions={DeployRunItemActions}
      emptyState={<>Nothing has been deployed from here yet.</>}
      source={source}
    />
  );
}

/**
 * One ledger row.
 *
 * The list view's field-driven row joins every non-primary field into ONE
 * truncated subtitle line, which is the right default and the wrong one for a
 * failure: the `message` is the CLI's own refusal, and this section exists partly
 * so those words survive the restart that used to eat them. So the row is
 * rendered through the list view's `renderRow` escape hatch — identity on the
 * first line, the message wrapped in full underneath — while the field schema
 * above still drives sort / filter / search and the table view.
 */
function HistoryRow({ run }: { run: DeployRunRecord }): ReactNode {
  return (
    <Fill>
      <Stack gap="2xs">
        <Cluster gap="xs">
          {outcomeBadge(run)}
          <Badge variant="muted">{run.verb}</Badge>
          {run.commitSha && (
            <Badge variant="muted" mono tooltip={run.commitSha}>
              {shortSha(run.commitSha)}
            </Badge>
          )}
          {run.releaseRunId && (
            <Badge
              variant="muted"
              mono
              tooltip={`Release run ${run.releaseRunId}`}
            >
              {run.releaseRunId}
            </Badge>
          )}
          <Text as="span" variant="caption" tone="muted">
            {durationLabel(run)} · <RelativeTime date={run.startedAt} />
          </Text>
        </Cluster>
        {run.status === "failed" && run.message && (
          <Text
            as="p"
            variant="caption"
            tone="destructive"
            className="whitespace-pre-wrap"
          >
            {run.message}
          </Text>
        )}
      </Stack>
    </Fill>
  );
}
