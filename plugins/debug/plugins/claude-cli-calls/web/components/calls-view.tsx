import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  claudeCliCalls,
  type ClaudeCliCallRow,
} from "@plugins/infra/plugins/claude-cli/core";
import {
  formatCallDuration,
  SLOW_CALL_MS,
} from "@plugins/infra/plugins/claude-cli/web";
import { modelMeta } from "@plugins/conversations/plugins/model-provider/core";
import { familyClass } from "@plugins/conversations/plugins/model-provider/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const CALLS_VIEW = defineDataView("debug.claude-cli-calls");

// The live source: the call log, a segmented window of which is ever loaded.
// Sort / filter / search compile to SQL server-side, and a new call reaches
// the window through the collection's producer — no tick, no refetch. Search
// runs over the source and the model's text (prompt / output / error); the
// Source and Model filter options are facets — a grouping of the whole log,
// not the loaded rows, so a source seen only in older calls is still offered.
const callsSource = liveDataSource(claudeCliCalls, {
  searchable: ["sourceName", "prompt", "output", "error"],
  facets: ["sourceName", "model"],
});

export function CallsView({
  selectedId,
  linkTo,
}: {
  selectedId?: string;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (id: string) => LinkTarget;
}) {
  return (
    <DataView<ClaudeCliCallRow>
      overrides={overrides}
      extraFields={extraFields}
      views={["table", "list"]}
      defaultView="table"
      storageKey={CALLS_VIEW}
      selectedRowId={selectedId}
      rowActivation={(r) => linkTo(r.id)}
      emptyState={<>No claude --print calls recorded yet.</>}
      source={callsSource}
    />
  );
}

/** What a row says at a glance: the error, else the output's first line. */
function summaryOf(call: ClaudeCliCallRow): string {
  if (call.error !== null) return call.error;
  return (call.output ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
}

/** A short `k=v` rendering of the caller's context, long values clipped. */
function contextSummary(context: Record<string, unknown> | null): string {
  if (context === null) return "";
  return Object.entries(context)
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${text.length > 14 ? `${text.slice(0, 12)}…` : text}`;
    })
    .join(" ");
}

// How the derived fields present here (the collection declares their labels,
// types and filters). `prompt`, `output` and `error` are filter-only text
// columns ("Prompt contains …", "Error is not empty"), hidden by default — the
// summary column already shows the output / error.
const overrides = fieldOverrides(claudeCliCalls, {
  status: {
    header: false,
    label: "Status",
    cell: (r) =>
      r.status === "error" ? (
        <StatusDot colorClass="bg-destructive" />
      ) : (
        <StatusDot colorClass="bg-success" />
      ),
    width: "2rem",
  },
  createdAt: {
    cell: (r) => (
      <Text tone="muted" title={r.createdAt.toLocaleString()}>
        <RelativeTime date={r.createdAt} />
      </Text>
    ),
    width: "7rem",
  },
  sourceName: {
    cell: (r) => (
      <Badge variant="muted" mono>
        {r.sourceName}
      </Badge>
    ),
    width: "12rem",
  },
  model: {
    cell: (r) => {
      const meta = modelMeta(r.model);
      return <Badge colorClass={familyClass(meta.family)}>{meta.label}</Badge>;
    },
    width: "8rem",
  },
  durationMs: {
    // A slow call (over SLOW_CALL_MS) reads in the warning tint.
    cell: (r) =>
      r.durationMs > SLOW_CALL_MS ? (
        <Text className="tabular-nums text-warning">
          {formatCallDuration(r.durationMs)}
        </Text>
      ) : (
        <Text tone="muted" className="tabular-nums">
          {formatCallDuration(r.durationMs)}
        </Text>
      ),
    align: "end",
    width: "6rem",
  },
  prompt: { visible: false },
  output: { visible: false },
  error: { visible: false },
});

// What the list computes itself: `summary` and `context` are derived from the
// row, so display-only.
const extraFields: FieldDef<ClaudeCliCallRow>[] = [
  {
    id: "summary",
    label: "Summary",
    type: "text",
    value: summaryOf,
    cell: (r) => {
      const summary = summaryOf(r);
      if (summary === "") return <Text tone="faint">&lt;empty&gt;</Text>;
      return r.status === "error" ? (
        <Text variant="code" tone="destructive">
          {summary}
        </Text>
      ) : (
        <Text>{summary}</Text>
      );
    },
    primary: true,
    sortable: false,
    filterable: false,
    width: "minmax(0,1fr)",
  },
  {
    id: "context",
    label: "Context",
    type: "text",
    value: (r) => contextSummary(r.sourceContext),
    cell: (r) => {
      const summary = contextSummary(r.sourceContext);
      return summary === "" ? null : (
        <Badge variant="muted" mono>
          {summary}
        </Badge>
      );
    },
    sortable: false,
    filterable: false,
    width: "minmax(0,14rem)",
  },
];
