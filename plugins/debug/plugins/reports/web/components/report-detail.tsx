import { useState } from "react";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import { useStaleFrontend } from "@plugins/build/web";
import { reportsList, type Report } from "@plugins/reports/core";
import { Reports, investigate } from "@plugins/reports/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { appLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { taskDetailRoute } from "@plugins/tasks/plugins/tasks-core/core";
import { reportDetailPane } from "../panes";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoFixHighIcon = symbol("auto-fix-high");

export function ReportDetail() {
  const { reportId } = reportDetailPane.useParams();
  // The report's row, live: a repeat moving its count, a noise flip or a
  // linked task arrives through the reports producer (`reports.list:rows`).
  const read = useLiveRow(reportsList, reportId);
  const { serverGraph } = useStaleFrontend();

  if (read.status === "loading") {
    return (
      <PaneChrome pane={reportDetailPane}>
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
      <PaneChrome pane={reportDetailPane}>
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
    <PaneChrome pane={reportDetailPane}>
      <ControlSizeProvider size="xs">
        <Scroll axis="both" fill>
          <Stack gap="lg" className="p-md">
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
              <TimeField label="First seen" date={report.firstSeenAt} />
              <TimeField label="Last seen" date={report.lastSeenAt} />
            </Stack>

            <Stack gap="xs">
              <Text as="div" variant="label" tone="muted">
                Details
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
        </Scroll>
      </ControlSizeProvider>
    </PaneChrome>
  );
}

function HeaderBadges({
  report: c,
  serverGraph,
}: {
  report: Report;
  /** The bundle graph this server is serving; `lastBuildId` holds the reporting tab's. */
  serverGraph: string | null;
}) {
  const tabId = getTabId();
  return (
    <Cluster>
      <Badge variant="muted" className="font-mono">
        {c.kind}
      </Badge>
      <Badge variant="muted" className="font-mono">
        {c.source}
      </Badge>
      {c.noise && <Badge variant="warning">noise</Badge>}
      {c.rateLimited && <Badge variant="destructive">rate-limited</Badge>}
      {c.lastClientId != null &&
        (c.lastClientId === tabId ? (
          <Badge variant="info">this tab</Badge>
        ) : (
          <Badge variant="muted">another tab</Badge>
        ))}
      {c.lastBuildId != null &&
        serverGraph != null &&
        c.lastBuildId !== serverGraph && (
          <Badge variant="warning">outdated tab</Badge>
        )}
      {c.count > 1 && (
        <span className="tabular-nums text-muted-foreground">×{c.count}</span>
      )}
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
  // The task investigate() linked, held until the live row carries it: the row
  // routes after the server's write resolves, so without it a second click in
  // between would launch a second agent. The row wins once it agrees.
  const [linkedTaskId, setLinkedTaskId] = useState<string | null>(null);
  const linked = report.taskId ?? linkedTaskId;
  if (linked != null) {
    const taskId = linked;
    return (
      <Stack align="start" gap="none">
        <Button
          variant="outline"
          {...appLinkProps(taskDetailRoute.link(agentManagerApp, { taskId }))}
          className="gap-xs"
        >
          <Icon icon={navIcons.expand} className="size-4" />
          View task
        </Button>
      </Stack>
    );
  }

  return (
    <Stack align="start" gap="none">
      <LaunchAgentPopover
        draftKey={`report-investigate:${report.id}`}
        trigger={
          <Button variant="default" className="gap-xs">
            <Icon icon={autoFixHighIcon} className="size-4" />
            Launch an agent to investigate
          </Button>
        }
        title="Investigate this report"
        description={
          <>
            {report.kind}: {report.message}
          </>
        }
        placeholder="Extra context (optional) — e.g. what you were doing, expected behaviour…"
        align="start"
        getRequest={async (userText) => {
          const { taskId } = await investigate(report.id);
          // Show "View task" now, before the linked row arrives.
          setLinkedTaskId(taskId);
          const parts: string[] = [];
          parts.push(`## Report (${report.kind})\n`);
          parts.push(`**Source:** ${report.source}`);
          parts.push(`**Message:** ${report.message}`);
          parts.push(
            `\n\`\`\`json\n${JSON.stringify(report.data, null, 2)}\n\`\`\``,
          );
          const extra = userText.trim();
          if (extra) {
            parts.push(`\n## Context\n\n${extra}`);
          }
          return { taskId, prompt: parts.join("\n") };
        }}
      />
    </Stack>
  );
}
