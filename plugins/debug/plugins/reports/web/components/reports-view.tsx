import {
  RelativeTime,
  useNow,
} from "@plugins/primitives/plugins/relative-time/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { TabOriginBadge } from "@plugins/apps-core/plugins/tab-origin/web";
import { useStaleFrontend } from "@plugins/build/web";
import {
  formatRecentCount,
  reportActivity,
  reportsList,
  REPORTS_SEARCHABLE,
} from "@plugins/reports/core";
import type { Report } from "@plugins/reports/core";
import { Reports } from "@plugins/reports/web";
import {
  DataViewSwitcher,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  DataViewSourceProps,
  FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { ReportsSources, type ReportsHostProps } from "../slots";
import { FixStateBadge } from "./fix-state-badge";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
// It IS `reportsList`'s column scope (asserted at mount): the surface whose
// custom columns sort and filter the live window.
const REPORTS_VIEW = defineDataView("debug.reports");

// The live source: every report, a segmented window of which is ever loaded
// here. Sort / filter / search compile to SQL server-side; a new report, a
// repeat moving a count, a noise flip or a linked task reaches the tuples
// holding that row through the reports producer — no tick, no refetch. The
// kind / source filter options are the facets: read live as a grouping of the
// whole table (not the loaded rows), value-sorted, so a new kind appears in its
// alphabetical place.
const reportsSource = liveDataSource(reportsList, {
  surface: REPORTS_VIEW,
  searchable: REPORTS_SEARCHABLE,
  facets: ["kind", "source"],
});

export function ReportsView(hostProps: ReportsHostProps) {
  return (
    <DataViewSwitcher
      storageKey={REPORTS_VIEW}
      sources={ReportsSources}
      hostProps={hostProps}
      defaultView="table"
    />
  );
}

type ReportsScope = ReturnType<typeof reportsSource.scoped>;

// One source per slice of the same reports, by where they stand against their
// fix. Each is the live source scoped server-side, so its counts, groups and
// search are the slice's own.
const SCOPES = {
  // What a supervisor works from: no fix named yet, or one that did not hold.
  worklist: reportsSource.scoped({
    where: { fixState: { in: ["open", "regressed"] }, noise: false },
  }),
  regressed: reportsSource.scoped({ where: { fixState: "regressed" } }),
  pending: reportsSource.scoped({ where: { fixState: "pending" } }),
  fixed: reportsSource.scoped({ where: { fixState: "fixed" } }),
} satisfies Record<string, ReportsScope>;

const EMPTY = {
  worklist: "Nothing to fix: every report is fixed, on its way, or noise.",
  regressed: "No regressions: every fix that went live has held.",
  pending: "No fix on its way.",
  fixed: "No report fixed yet. A push names its fix with --fixes-report.",
  all: "No reports recorded yet.",
} as const;

function sourceComponent(
  scope: ReportsScope | typeof reportsSource,
  emptyState: string,
) {
  return function ReportsSource({
    hostProps,
    render,
  }: DataViewSourceProps<ReportsHostProps>) {
    return render<Report>({
      source: scope,
      overrides,
      extraFields,
      selectedRowId: hostProps.selectedId,
      rowActivation: (r) => hostProps.linkTo(r.id),
      emptyState: <>{emptyState}</>,
    });
  };
}

export const WorklistSource = sourceComponent(SCOPES.worklist, EMPTY.worklist);
export const RegressedSource = sourceComponent(
  SCOPES.regressed,
  EMPTY.regressed,
);
export const PendingSource = sourceComponent(SCOPES.pending, EMPTY.pending);
export const FixedSource = sourceComponent(SCOPES.fixed, EMPTY.fixed);
export const AllReportsSource = sourceComponent(reportsSource, EMPTY.all);

// How the derived fields present here. `kind` and `source` declare no
// `options` — their option lists are the source's facets. `message` and
// `fingerprint` are searched only (the summary shows the message).
const overrides = fieldOverrides(reportsList, {
  kind: {
    cell: (r) => (
      <Badge variant="muted" className="font-mono">
        {r.kind}
      </Badge>
    ),
    width: "10rem",
  },
  source: {
    cell: (r) => (
      <Badge variant="muted" className="font-mono">
        {r.source}
      </Badge>
    ),
    width: "10rem",
  },
  noise: {
    cell: (r) => (r.noise ? <Badge variant="warning">noise</Badge> : null),
    width: "6rem",
  },
  rateLimited: {
    cell: (r) =>
      r.rateLimited ? <Badge variant="destructive">rate-limited</Badge> : null,
    width: "8rem",
  },
  // The lifetime total, beside the recent count (`extraFields`): sortable,
  // never the number a row leads with.
  count: {
    cell: (r) => (
      <span className="tabular-nums text-faint-foreground">
        {r.count.toLocaleString("en-US")}
      </span>
    ),
    width: "5rem",
  },
  lastSeenAt: {
    cell: (r) => (
      <span className="text-muted-foreground">
        <RelativeTime date={r.lastSeenAt} />
      </span>
    ),
    width: "7rem",
  },
  fixState: {
    cell: (r) => <FixStateBadge report={r} />,
    width: "9rem",
  },
  message: { visible: false },
  fingerprint: { visible: false },
});

// Static: the fields the list computes itself.
const extraFields: FieldDef<Report>[] = [
  {
    id: "context",
    label: "",
    type: "text",
    // Presentational-only: the attribution badges depend on client hooks,
    // so this field carries no comparable value and is excluded from
    // search / filter / sort.
    value: () => "",
    cell: (r) => <AttributionBadges report={r} />,
    sortable: false,
    filterable: false,
    width: "auto",
  },
  {
    id: "last24h",
    label: "24 h",
    type: "text",
    // Read against the clock, so neither sortable nor filterable server-side.
    value: () => "",
    cell: (r) => <RecentCount report={r} />,
    sortable: false,
    filterable: false,
    width: "4rem",
  },
  {
    id: "summary",
    label: "Summary",
    type: "text",
    // `value` is the human message (search runs server-side, over the
    // message / kind / fingerprint); the visible cell routes through the
    // per-kind slot.
    value: (r) => r.message,
    cell: (r) => <Reports.KindView.Dispatch report={r} />,
    primary: true,
    sortable: false,
    width: "minmax(0,2fr)",
  },
];

/**
 * Tab / build attribution badges, lifted verbatim from the old `ReportRow`.
 * A standalone component because `FieldDef.cell` is a plain `(row) => ReactNode`
 * and cannot call hooks itself.
 */
function AttributionBadges({ report: c }: { report: Report }) {
  const { serverGraph } = useStaleFrontend();
  return (
    <>
      <TabOriginBadge stamp={{ clientId: c.lastClientId, url: c.url }} />
      {c.lastBuildId != null &&
        serverGraph != null &&
        c.lastBuildId !== serverGraph && (
          <Badge variant="warning">outdated tab</Badge>
        )}
    </>
  );
}

/** How many times the report fired in the last 24 h (`≥ n` when only a floor is known). */
function RecentCount({ report }: { report: Report }) {
  const now = useNow(60_000);
  const activity = reportActivity(report, now);
  return (
    <span
      className={
        activity.recent.n > 0
          ? "tabular-nums text-foreground"
          : "tabular-nums text-faint-foreground"
      }
    >
      {formatRecentCount(activity)}
    </span>
  );
}
