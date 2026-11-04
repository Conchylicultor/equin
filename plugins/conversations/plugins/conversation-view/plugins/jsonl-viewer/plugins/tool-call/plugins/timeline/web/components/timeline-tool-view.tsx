import { useMemo } from "react";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  readTimelineReport,
  type TimelineReport,
  type TimelineReportEvent,
} from "@plugins/debug/plugins/timeline/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import {
  describeTimelineInput,
  eventsNote,
  type TimelineInput,
} from "../internal/describe";

const SEVERITY_BADGE = {
  info: "muted",
  warning: "warning",
  error: "destructive",
} as const;

const EVENT_COLUMNS: ColumnDef<TimelineReportEvent>[] = [
  {
    id: "time",
    header: "Time",
    cell: (e) => (
      <Text as="span" variant="caption" tone="muted" className="font-mono">
        {e.time}
      </Text>
    ),
  },
  {
    id: "severity",
    header: "Severity",
    cell: (e) => (
      <Badge variant={SEVERITY_BADGE[e.severity]} className={rigidClass()}>
        {e.severity}
      </Badge>
    ),
  },
  {
    id: "source",
    header: "Source",
    cell: (e) => (
      <Text as="span" variant="caption">
        {e.source}
      </Text>
    ),
  },
  {
    id: "worktree",
    header: "Worktree",
    cell: (e) => (
      <Text as="span" variant="caption" tone="muted" className="font-mono">
        {e.worktree}
      </Text>
    ),
  },
  {
    id: "label",
    header: "Event",
    width: "minmax(0,1fr)",
    cell: (e) => (
      <Text
        as="span"
        variant="caption"
        className="whitespace-pre-wrap break-words"
        title={e.traceId ? `trace ${e.traceId}` : undefined}
      >
        {e.label.trim()}
      </Text>
    ),
  },
];

/** The sections that read as lines. A section that only says "none" is left out. */
const LINE_SECTIONS = [
  { id: "duress", label: "Duress" },
  { id: "host-pressure", label: "Host pressure" },
  { id: "backend-health", label: "Backend health" },
  { id: "chunk-errors", label: "Chunk errors" },
] as const;

function Report({ report }: { report: TimelineReport }) {
  return (
    <Stack gap="sm">
      <Text as="p" variant="caption" tone="muted">
        {report.from} → {report.to} ({report.tz}) · scanned {report.scanned}{" "}
        chunks · {report.duress} duress · {report.healthLanes} health lanes
      </Text>
      {LINE_SECTIONS.map(({ id, label }) => {
        const lines = report.sections
          .find((s) => s.id === id)
          ?.lines.filter((l) => !/^\s*none\b/.test(l));
        if (!lines || lines.length === 0) return null;
        return (
          <Stack key={id} gap="2xs">
            <Text as="p" variant="caption" tone="muted">
              {label}
            </Text>
            <Text
              as="pre"
              variant="caption"
              className="font-mono whitespace-pre-wrap break-words"
            >
              {lines.map((l) => l.trim()).join("\n")}
            </Text>
          </Stack>
        );
      })}
      {report.shown.length > 0 && (
        <Scroll className="max-h-80">
          <DataTable
            data={report.shown}
            columns={EVENT_COLUMNS}
            rowKey={(_, i) => String(i)}
            density="compact"
          />
        </Scroll>
      )}
      {report.dropped && (
        <Text as="p" variant="caption" tone="muted">
          {report.dropped}
        </Text>
      )}
    </Stack>
  );
}

export function TimelineToolView({ event }: ToolRendererProps) {
  const input = event.input as TimelineInput;
  const content = event.result?.content;
  const failed = event.result?.isError === true;
  const read = useMemo(
    () => (content === undefined ? undefined : readTimelineReport(content)),
    [content],
  );
  const report = read?.kind === "report" ? read.report : undefined;

  return (
    <ToolCallCard
      event={event}
      summary={describeTimelineInput(input)}
      note={report && eventsNote(report.shown.length, report.events)}
      defaultOpen={failed}
    >
      {report && <Report report={report} />}
      {!report && content !== undefined && (
        <Text
          as="p"
          variant="caption"
          tone={failed ? "destructive" : "muted"}
          className="whitespace-pre-wrap"
        >
          {content}
        </Text>
      )}
    </ToolCallCard>
  );
}
