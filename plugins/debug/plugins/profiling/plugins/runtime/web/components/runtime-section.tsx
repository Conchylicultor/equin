import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, type ReactElement } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { formatDuration } from "@plugins/debug/plugins/profiling/web";
import { resetRuntimeProfile } from "../../core";
import { runtimeProfile } from "../../shared/resources";
import {
  SPAN_KINDS,
  type SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";

const RUNTIME_VIEW = defineDataView("debug.profiling.runtime");

type RuntimeKind = SpanKind;

// The Kind column's label per span kind. Exhaustive over SpanKind, so a new kind
// is a tsc error here until it has a label (it no longer drops out silently).
const KIND_LABEL: Record<SpanKind, string> = {
  http: "HTTP",
  db: "DB",
  loader: "Loader",
  sub: "Sub",
  push: "Push",
  flush: "Flush",
  job: "Job",
  cascade: "Cascade",
  bg: "BG",
  route: "Route",
  membership: "Membership",
};

interface ParentRow {
  kind: RuntimeKind;
  label: string;
  count: number;
}

interface AggRow {
  label: string;
  count: number;
  avgMs: number;
  /** Per-call gate-wait union (waitTotalMs / count): time queued on named gates. */
  waitMs: number;
  /** Per-call direct-child execution union (childTotalMs / count). */
  childMs: number;
  /** Per-call own orchestration (selfTotalMs / count): wall − union(waits ∪ children). */
  selfMs: number;
  maxMs: number;
  /** Age of the since-boot maxMs peak — an old peak reads as old. */
  maxAgeMs: number;
  /** Max duration within the rolling ~5-min window; 0 when idle past it. */
  recentMaxMs: number;
  lastMs: number;
  byParent: ParentRow[];
  /** Per-layer wait (gate/lock → summed per-record union ms) across this label's records. */
  waits: Record<string, number>;
}

type RuntimeRow = AggRow & { kind: RuntimeKind };

// How many distinct callers to render inline before collapsing into "+N more".
const MAX_PARENTS_SHOWN = 3;

// Compact human age for a duration in ms (maxAgeMs is an age, not a Date, so
// formatRelativeTime doesn't apply directly — this mirrors its output style).
function formatMsAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function CallerBreakdown({ parents }: { parents: ParentRow[] }): ReactElement {
  const shown = parents.slice(0, MAX_PARENTS_SHOWN);
  const rest = parents.slice(MAX_PARENTS_SHOWN);
  const restTitle = rest
    .map((p) => `${p.kind}:${p.label} ×${p.count}`)
    .join("\n");
  return (
    <Stack gap="2xs" className="pl-md">
      {shown.map((p) => (
        <span
          key={`${p.kind}:${p.label}`}
          className="truncate font-mono text-3xs text-muted-foreground"
          title={`${p.kind}:${p.label}`}
        >
          ↳ {p.kind}:{p.label} ×{p.count}
        </span>
      ))}
      {rest.length > 0 && (
        <span
          className="font-mono text-3xs text-muted-foreground"
          title={restTitle}
        >
          +{rest.length} more caller{rest.length === 1 ? "" : "s"}
        </span>
      )}
    </Stack>
  );
}

// The per-layer wait split beneath an entry's label: ⏳ background-acquire 1700ms.
// Makes head-of-line blocking visible inline (which gate, how long).
function WaitBreakdownLines({
  waits,
}: {
  waits: Record<string, number>;
}): ReactElement {
  return (
    <Stack gap="2xs" className="pl-md">
      {Object.entries(waits).map(([layer, ms]) => (
        <span
          key={layer}
          className="truncate font-mono text-3xs text-muted-foreground"
          title={`${layer}: ${Math.round(ms)}ms wait`}
        >
          ⏳ {layer} {Math.round(ms)}ms
        </span>
      ))}
    </Stack>
  );
}

function toAggRows(
  aggregates: {
    label: string;
    count: number;
    totalMs: number;
    maxMs: number;
    maxAgeMs: number;
    recentMaxMs: number;
    lastMs: number;
    waitTotalMs: number;
    childTotalMs: number;
    selfTotalMs: number;
    byParent: { parent: { kind: RuntimeKind; label: string }; count: number }[];
    waits?: Record<string, number>;
  }[],
): AggRow[] {
  return aggregates
    .map((agg) => ({
      label: agg.label,
      count: agg.count,
      avgMs: Math.round(agg.totalMs / agg.count),
      waitMs: Math.round(agg.waitTotalMs / agg.count),
      childMs: Math.round(agg.childTotalMs / agg.count),
      selfMs: Math.round(agg.selfTotalMs / agg.count),
      maxMs: Math.round(agg.maxMs),
      maxAgeMs: agg.maxAgeMs,
      recentMaxMs: Math.round(agg.recentMaxMs),
      lastMs: Math.round(agg.lastMs),
      byParent: agg.byParent.map((pb) => ({
        kind: pb.parent.kind,
        label: pb.parent.label,
        count: pb.count,
      })),
      waits: agg.waits ?? {},
    }))
    .sort((a, b) => b.recentMaxMs - a.recentMaxMs);
}

const RUNTIME_FIELDS: FieldDef<RuntimeRow>[] = [
  {
    id: "kind",
    label: "Kind",
    type: "enum",
    value: (r) => r.kind,
    options: SPAN_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
    width: "5rem",
  },
  {
    id: "label",
    label: "Label",
    type: "text",
    primary: true,
    value: (r) => r.label,
    width: "minmax(0,1fr)",
    // Renders the per-caller attribution breakdown inline (empty for HTTP,
    // which has no parent).
    cell: (row) => (
      <Stack gap="2xs" className={yieldClass("x")}>
        <Text
          as="span"
          variant="caption"
          className="truncate font-mono"
          title={row.label}
        >
          {row.label}
        </Text>
        {row.byParent.length > 0 && <CallerBreakdown parents={row.byParent} />}
        {Object.keys(row.waits).length > 0 && (
          <WaitBreakdownLines waits={row.waits} />
        )}
      </Stack>
    ),
  },
  {
    id: "count",
    label: "Count",
    type: "number",
    value: (r) => r.count,
    align: "end",
    width: "3.5rem",
  },
  {
    id: "avgMs",
    label: "Avg (ms)",
    type: "number",
    value: (r) => r.avgMs,
    align: "end",
    width: "5rem",
  },
  {
    id: "selfMs",
    label: "Self (ms)",
    type: "number",
    value: (r) => r.selfMs,
    align: "end",
    width: "5rem",
  },
  {
    id: "childMs",
    label: "Child (ms)",
    type: "number",
    value: (r) => r.childMs,
    align: "end",
    width: "5rem",
  },
  {
    id: "recentMaxMs",
    label: "Recent max (ms)",
    type: "number",
    value: (r) => r.recentMaxMs,
    align: "end",
    width: "6.5rem",
  },
  {
    id: "maxMs",
    label: "Max (ms)",
    type: "number",
    value: (r) => r.maxMs,
    align: "end",
    width: "9rem",
    // Since-boot peak with its age alongside, so a stale spike reads as stale.
    cell: (row) => (
      <Text as="span" variant="caption" className="truncate font-mono">
        {row.maxMs.toLocaleString()} · {formatMsAge(row.maxAgeMs)}
      </Text>
    ),
  },
  {
    id: "lastMs",
    label: "Last (ms)",
    type: "number",
    value: (r) => r.lastMs,
    align: "end",
    width: "5rem",
  },
];

export function RuntimeSection(): ReactElement {
  // A snapshot of the in-memory recorder: measured on mount, on Refresh and
  // after Reset window. NOT pushed — it moves on every span.
  const profile = useLive(runtimeProfile);
  // The rows are memoized above the per-state returns below (hooks order), so
  // they fold every state; only the ready arm renders them.
  const data = foldResource(profile, {
    loading: () => null,
    error: () => null,
    ready: (d) => d,
  });

  const resetMutation = useEndpointMutation(resetRuntimeProfile);

  const rows = useMemo<RuntimeRow[]>(() => {
    if (data === null) return [];
    const tag = (kind: RuntimeKind, aggs: AggRow[]): RuntimeRow[] =>
      aggs.map((r) => ({ ...r, kind }));
    return SPAN_KINDS.flatMap((k) => tag(k, toAggRows(data.aggregates[k])));
  }, [data]);

  if (profile.status === "loading") {
    return <Loading variant="spinner" label="Reading the runtime profile…" />;
  }
  if (profile.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the runtime profile"
        error={profile.error}
        refetch={profile.refetch}
      />
    );
  }

  const title = `Runtime — recent max · ${formatDuration(profile.data.windowMs)} window`;

  return (
    <DataView<RuntimeRow>
      rows={rows}
      fields={RUNTIME_FIELDS}
      rowKey={(r) => `${r.kind}:${r.label}`}
      storageKey={RUNTIME_VIEW}
      title={title}
      actions={
        <Stack direction="row" gap="xs">
          <Button variant="ghost" onClick={() => profile.refresh()}>
            Refresh
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await resetMutation.mutateAsync({});
              await profile.refresh();
            }}
          >
            Reset window
          </Button>
        </Stack>
      }
      defaultView="table"
      emptyState="No runtime spans recorded"
    />
  );
}
