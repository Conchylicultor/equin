import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { deadJobs, type DeadJobRow } from "@plugins/infra/plugins/jobs/core";
import {
  DataView,
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
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
    <DataView<DeadJobRow>
      storageKey={DEAD_VIEW}
      fields={fields}
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

// Static: every sortable / filterable field's id IS its collection column.
const fields: FieldDef<DeadJobRow>[] = [
  {
    id: "jobName",
    label: "Job",
    type: "enum",
    value: (r) => r.jobName,
    cell: (r) => <JobBadge name={r.jobName} />,
    primary: true,
    sortable: true,
    filterable: true,
    width: "minmax(8rem,16rem)",
  },
  {
    id: "attempts",
    label: "Attempts",
    type: "int",
    value: (r) => r.attempts,
    cell: (r) => (
      <Text tone="muted" className="tabular-nums">
        {r.attempts}/{r.maxAttempts}
      </Text>
    ),
    sortable: true,
    filterable: true,
    align: "end",
    width: "5rem",
  },
  {
    id: "diedAt",
    label: "Died",
    type: "date",
    value: (r) => r.diedAt,
    // An archive row from before `diedAt` was recorded reads its archive time.
    cell: (r) =>
      r.diedAt !== null ? (
        <WhenText date={r.diedAt} prefix="Died" />
      ) : (
        <WhenText date={r.archivedAt} prefix="Archived" />
      ),
    sortable: true,
    filterable: true,
    align: "end",
    width: "6rem",
  },
  {
    id: "lastError",
    label: "Last error",
    type: "text",
    value: (r) => r.lastError,
    cell: (r) =>
      r.lastError === null ? null : (
        <Text variant="code" tone="destructive" title={r.lastError}>
          {firstLine(r.lastError)}
        </Text>
      ),
    sortable: false,
    filterable: true,
    width: "minmax(0,1fr)",
  },
  {
    id: "archivedAt",
    label: "Archived",
    type: "date",
    value: (r) => r.archivedAt,
    cell: (r) => <WhenText date={r.archivedAt} prefix="Archived" />,
    sortable: true,
    filterable: true,
    align: "end",
    width: "6rem",
    visible: false,
  },
];
