import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  deadJobs,
  type DeadJobListRow,
} from "@plugins/infra/plugins/jobs/core";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { firstLine } from "../internal/format";
import { JobBadge, WhenText } from "./cells";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const DEAD_VIEW = defineDataView("debug.queue.dead");

// The dead-letter archive as a live source: sort / filter / search compile to
// SQL server-side, and the dead-job GC's archive and purge reach the window
// through the change feed. The Job filter options are a facet — a grouping of
// the whole archive, not of the loaded rows.
const deadSource = liveDataSource(deadJobs, {
  searchable: ["jobName", "lastError"],
  facets: ["jobName"],
});

/**
 * Debug → Queue's Dead section: permanently-failed jobs archived from the
 * queue (bounded to `DEAD_JOBS_ARCHIVE_CAP`; GC'd hourly).
 */
export function DeadView({
  selectedId,
  linkTo,
}: {
  selectedId?: string;
  linkTo: (id: string) => LinkTarget;
}) {
  return (
    <DataView<DeadJobListRow>
      storageKey={DEAD_VIEW}
      overrides={overrides}
      views={["table", "list"]}
      defaultView="table"
      source={deadSource}
      searchPlaceholder="Search dead jobs…"
      selectedRowId={selectedId}
      rowActivation={(r) => linkTo(r.id)}
      emptyState={<>No dead jobs. Permanently-failed jobs are archived here.</>}
    />
  );
}

// How the derived fields present here (the collection declares their labels,
// types and filters).
const overrides = fieldOverrides(deadJobs, {
  jobName: {
    cell: (r) => <JobBadge name={r.jobName} />,
    width: "minmax(8rem,16rem)",
  },
  attempts: {
    cell: (r) => (
      <Text tone="muted" className="tabular-nums">
        {r.attempts}/{r.maxAttempts}
      </Text>
    ),
    align: "end",
    width: "5rem",
  },
  diedAt: {
    // An archive row from before `diedAt` was recorded reads its archive time.
    cell: (r) =>
      r.diedAt !== null ? (
        <WhenText date={r.diedAt} prefix="Died" />
      ) : (
        <WhenText date={r.archivedAt} prefix="Archived" />
      ),
    align: "end",
    width: "6rem",
  },
  lastError: {
    cell: (r) =>
      r.lastError === null ? null : (
        <Text variant="code" tone="destructive" title={r.lastError}>
          {firstLine(r.lastError)}
        </Text>
      ),
    width: "minmax(0,1fr)",
  },
  archivedAt: {
    cell: (r) => <WhenText date={r.archivedAt} prefix="Archived" />,
    align: "end",
    width: "6rem",
    visible: false,
  },
});
