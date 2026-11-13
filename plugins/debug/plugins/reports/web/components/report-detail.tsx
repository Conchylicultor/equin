import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  RelativeTime,
  useNow,
} from "@plugins/primitives/plugins/relative-time/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { TabOriginBadge } from "@plugins/apps-core/plugins/tab-origin/web";
import { useStaleFrontend } from "@plugins/build/web";
import {
  formatReportActivity,
  reportActivity,
  reportsList,
  type Report,
} from "@plugins/reports/core";
import { Reports } from "@plugins/reports/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ReportInvestigate } from "./report-investigate";
import { reportDetailPane } from "../panes";
import { ReportOccurrences } from "./report-occurrences";
import { FixStateBadge } from "./fix-state-badge";

export function ReportDetail() {
  const { reportId } = reportDetailPane.useParams();
  // The report's row, live: a repeat moving its count, a noise flip or a
  // linked task arrives through the reports producer (`reports.list:rows`).
  const read = useLive(reportsList, { id: reportId });
  const { serverGraph } = useStaleFrontend();

  if (read.status === "loading") {
    return (
      <PaneChrome pane={reportDetailPane} inset="document">
        <Loading />
      </PaneChrome>
    );
  }

  // A failed read keeps painting the row it last saw; with none, the failure
  // and its Retry — never "not found", which nobody said.
  const report =
    read.status === "error" ? read.stale : read.found ? read.row : undefined;
  if (report === undefined) {
    return (
      <PaneChrome pane={reportDetailPane} inset="document">
        {read.status === "error" ? (
          <ResourceErrorInline
            variant="inline"
            subject="this report"
            error={read.error}
            refetch={read.refetch}
          />
        ) : (
          <Center className="h-full">
            <Text as="div" variant="body" className="text-muted-foreground">
              Report not found.
            </Text>
          </Center>
        )}
      </PaneChrome>
    );
  }

  return (
    <PaneChrome pane={reportDetailPane} inset="document">
      {/* No scroller of its own: the pane's is the one scroll, and a nested
          one would clip the Occurrences table's bleed to the pane edge. */}
      <ControlSizeProvider size="xs">
        <Stack gap="lg">
          <HeaderBadges report={report} serverGraph={serverGraph} />

          <Text
            as="div"
            variant="body"
            className="whitespace-pre-wrap break-words text-foreground"
          >
            {report.message}
          </Text>

          <Investigate key={report.id} report={report} />

          <Stack gap="sm">
            <Field label="Kind" value={report.kind} mono />
            <Field label="Source" value={report.source} mono />
            <Field label="Worktree" value={report.worktree} mono />
            <Field label="Fingerprint" value={report.fingerprint} mono />
            {report.url && <Field label="URL" value={report.url} mono />}
            {report.userAgent && (
              <Field label="User agent" value={report.userAgent} />
            )}
            {report.fixCommit !== null && (
              <Field label="Fix" value={report.fixCommit} mono />
            )}
            {report.fixStateAt !== null && (
              <TimeField
                label={STATE_SINCE[report.fixState]}
                date={report.fixStateAt}
              />
            )}
            {report.lastCommit !== null && (
              <Field
                label="Latest occurrence ran"
                value={report.lastCommit}
                mono
              />
            )}
            <TimeField label="First seen" date={report.firstSeenAt} />
            <TimeField label="Last seen" date={report.lastSeenAt} />
          </Stack>

          <Stack gap="xs">
            <Text as="div" variant="label" tone="muted">
              {report.count > report.recent.length
                ? `Last ${report.recent.length} of ${report.count} occurrences`
                : "Occurrences"}
            </Text>
            <ReportOccurrences report={report} />
          </Stack>

          <Stack gap="xs">
            <Text as="div" variant="label" tone="muted">
              Details (latest occurrence)
            </Text>
            {/* Per-kind payload view, dispatched by report.kind. */}
            <Reports.KindView.Dispatch report={report} />
          </Stack>

          <Stack gap="xs">
            <Text as="div" variant="label" tone="muted">
              Raw data
            </Text>
            <Scroll
              as="pre"
              axis="both"
              className="rounded-md bg-muted p-sm text-caption"
            >
              {JSON.stringify(report.data, null, 2)}
            </Scroll>
          </Stack>
        </Stack>
      </ControlSizeProvider>
    </PaneChrome>
  );
}

// What the status timestamp is, per state (open has none).
const STATE_SINCE: Record<Report["fixState"], string> = {
  open: "Status since",
  pending: "Fix landed on main",
  fixed: "Fix went live",
  regressed: "Regressed",
};

function HeaderBadges({
  report: c,
  serverGraph,
}: {
  report: Report;
  /** The bundle graph this server is serving; `lastBuildId` holds the reporting tab's. */
  serverGraph: string | null;
}) {
  const now = useNow(60_000);
  return (
    <Cluster>
      <Badge variant="muted" className="font-mono">
        {c.kind}
      </Badge>
      <Badge variant="muted" className="font-mono">
        {c.source}
      </Badge>
      <FixStateBadge report={c} />
      {c.noise && <Badge variant="warning">noise</Badge>}
      {c.rateLimited && <Badge variant="destructive">rate-limited</Badge>}
      <TabOriginBadge stamp={{ clientId: c.lastClientId, url: c.url }} />
      {c.lastBuildId != null &&
        serverGraph != null &&
        c.lastBuildId !== serverGraph && (
          <Badge variant="warning">outdated tab</Badge>
        )}
      <span className="tabular-nums text-muted-foreground">
        {formatReportActivity(reportActivity(c, now))}
      </span>
      <span className="text-muted-foreground">
        <RelativeTime date={c.lastSeenAt} />
      </span>
    </Cluster>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Stack gap="2xs">
      <Text as="div" variant="caption" tone="muted">
        {label}
      </Text>
      <Text
        as="div"
        variant="body"
        className={
          mono
            ? "font-mono break-all text-foreground"
            : "break-words text-foreground"
        }
      >
        {value}
      </Text>
    </Stack>
  );
}

function TimeField({ label, date }: { label: string; date: Date }) {
  return (
    <Stack gap="2xs">
      <Text as="div" variant="caption" tone="muted">
        {label}
      </Text>
      <Text as="div" variant="body" className="text-foreground">
        <RelativeTime date={date} />
      </Text>
    </Stack>
  );
}

function Investigate({ report }: { report: Report }) {
  return (
    <Stack align="start" gap="none">
      <ReportInvestigate report={report} presentation="button" />
    </Stack>
  );
}
