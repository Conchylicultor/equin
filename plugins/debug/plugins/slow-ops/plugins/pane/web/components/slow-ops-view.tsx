import { useMemo, type ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import {
  slowOpsValue,
  type SlowOp,
  type CallerBreakdown,
  type SlowOpMeasures,
  type VariantBreakdown,
} from "@plugins/debug/plugins/slow-ops/core";
import {
  SPAN_MEASURES,
  type SpanMeasure,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

// Newest captured sample first; deep-link its trace when the engine admitted one.
function newestTraceId(op: SlowOp): string | undefined {
  return op.recentSamples[0]?.traceId;
}

const SLOW_OPS_LOCAL = defineDataView("debug.slow-ops.local");

function CallerBreakdownLines({
  callers,
}: {
  callers: CallerBreakdown[];
}): ReactElement {
  const sorted = [...callers].sort((a, b) => b.totalMs - a.totalMs);
  return (
    <Stack gap="2xs" className="pl-md">
      {sorted.map((c) => (
        <span
          key={`${c.kind}:${c.label}`}
          className="truncate font-mono text-3xs text-muted-foreground"
          title={`${c.kind}:${c.label}`}
        >
          ↳ {c.kind}:{c.label} ×{c.count} ({Math.round(c.totalMs)} ms)
        </span>
      ))}
    </Stack>
  );
}

// The durable wait-vs-work split beneath an operation: ⏳ heavy-read-acquire
// 3500ms. Surfaces head-of-line blocking / lock-vs-work without manual repro.
function WaitBreakdownLines({
  waits,
}: {
  waits: Record<string, number>;
}): ReactElement {
  const sorted = Object.entries(waits).sort((a, b) => b[1] - a[1]);
  return (
    <Stack gap="2xs" className="pl-md">
      {sorted.map(([layer, ms]) => (
        <span
          key={layer}
          className="truncate font-mono text-3xs text-muted-foreground"
          title={`${layer}: ${Math.round(ms)}ms wait`}
        >
          ⏳ {layer} {Math.round(ms)} ms
        </span>
      ))}
    </Stack>
  );
}

// Which instances of the operation were slow (a loader's params): ◇ {"id":"…"}
// ×3 (4200 ms). Slowest total first; the folded tail reads as "(other)".
function VariantBreakdownLines({
  variants,
}: {
  variants: VariantBreakdown[];
}): ReactElement {
  const sorted = [...variants].sort((a, b) => b.totalMs - a.totalMs);
  return (
    <Stack gap="2xs" className="pl-md">
      {sorted.map((v) => (
        <span
          key={v.variant}
          className="truncate font-mono text-3xs text-muted-foreground"
          title={v.variant}
        >
          ◇ {v.variant} ×{v.count} ({Math.round(v.totalMs)} ms)
        </span>
      ))}
    </Stack>
  );
}

// How each measure reads on screen. Exhaustive over SpanMeasure, so a new
// measure is a tsc error here until it has a label.
const MEASURE_LABEL: Record<SpanMeasure, (v: number) => string> = {
  subscribers: (v) => `${v} subscribers`,
  frameChars: (v) =>
    v >= 1024 ? `${(v / 1024).toFixed(1)}k chars` : `${v} chars`,
  ids: (v) => `${v} ids`,
  sinceChangeMs: (v) => `${Math.round(v)} ms since change`,
};

// The numbers the slow spans carried: # max 42 subscribers · last 40.
function MeasureLines({
  measures,
}: {
  measures: SlowOpMeasures;
}): ReactElement {
  return (
    <Stack gap="2xs" className="pl-md">
      {SPAN_MEASURES.map((m) => {
        const stat = measures[m];
        if (!stat) return null;
        const text = `max ${MEASURE_LABEL[m](stat.max)} · last ${MEASURE_LABEL[m](stat.last)}`;
        return (
          <span
            key={m}
            className="truncate font-mono text-3xs text-muted-foreground"
            title={text}
          >
            # {text}
          </span>
        );
      })}
    </Stack>
  );
}

const sumWaits = (waits: Record<string, number>): number =>
  Object.values(waits).reduce((a, b) => a + b, 0);

// A snapshot, re-read on every mount and on Refresh: `slow_ops` is
// change-feed-excluded, so nothing is pushed (see `slowOpsValue`).
export function SlowOpsView() {
  const ops = useLive(slowOpsValue);
  return matchResource(ops, {
    loading: () => <Loading />,
    error: (error) => (
      <ResourceErrorInline
        variant="block"
        subject="slow operations"
        error={error}
        refetch={ops.refetch}
      />
    ),
    ready: (data) => (
      <SlowOpsViewInner
        ops={data}
        refresh={
          <Button
            variant="outline"
            onClick={async () => {
              await ops.refresh();
            }}
          >
            Refresh
          </Button>
        }
      />
    ),
  });
}

function SlowOpsViewInner({
  ops,
  refresh,
}: {
  ops: SlowOp[];
  refresh: ReactElement;
}) {
  // Default ranking: aggregate impact (total time across all occurrences). A
  // structural bottleneck — one query draining many routes — surfaces at the top.
  const data = useMemo(
    () => [...ops].sort((a, b) => b.totalMs - a.totalMs),
    [ops],
  );

  const fields = useMemo<FieldDef<SlowOp>[]>(() => {
    const kinds = Array.from(new Set(data.map((r) => r.operationKind)));
    return [
      {
        id: "operationKind",
        label: "Kind",
        type: "enum",
        value: (r) => r.operationKind,
        options: kinds.map((k) => ({ value: k, label: k })),
        width: "7rem",
      },
      {
        id: "operation",
        label: "Operation",
        type: "text",
        primary: true,
        value: (r) => r.operation,
        width: "minmax(0,1fr)",
        cell: (r) => (
          <Stack gap="2xs" className={yieldClass("x")}>
            <Text
              as="span"
              variant="caption"
              className="truncate font-mono"
              title={r.operation}
            >
              {r.operation}
            </Text>
            {r.callers.length > 0 && (
              <CallerBreakdownLines callers={r.callers} />
            )}
            {Object.keys(r.waits).length > 0 && (
              <WaitBreakdownLines waits={r.waits} />
            )}
            {r.variants.length > 0 && (
              <VariantBreakdownLines variants={r.variants} />
            )}
            {Object.keys(r.measures).length > 0 && (
              <MeasureLines measures={r.measures} />
            )}
            {newestTraceId(r) && (
              <Stack direction="row" gap="2xs" align="start">
                <LinkChip
                  leading={<Icon icon={boltIcon} className="icon-auto" />}
                  activation={appLink(
                    traceDetailRoute.link(debugApp, { id: newestTraceId(r)! }),
                  )}
                >
                  trace
                </LinkChip>
              </Stack>
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
        width: "4rem",
      },
      {
        id: "totalMs",
        label: "Total (ms)",
        type: "number",
        value: (r) => Math.round(r.totalMs),
        align: "end",
        width: "5.5rem",
      },
      {
        id: "waitMs",
        label: "Wait (ms)",
        type: "number",
        value: (r) => Math.round(sumWaits(r.waits)),
        align: "end",
        width: "5.5rem",
      },
      {
        id: "maxMs",
        label: "Max (ms)",
        type: "number",
        value: (r) => Math.round(r.maxMs),
        align: "end",
        width: "5rem",
      },
      {
        id: "lastMs",
        label: "Last (ms)",
        type: "number",
        value: (r) => Math.round(r.lastMs),
        align: "end",
        width: "5rem",
      },
      {
        id: "lastSeen",
        label: "Last seen",
        type: "date",
        value: (r) => r.lastSeenAt,
        cell: (r) => <RelativeTime date={r.lastSeenAt} />,
        align: "end",
        width: "7rem",
      },
    ];
  }, [data]);

  return (
    <DataView<SlowOp>
      rows={data}
      fields={fields}
      rowKey={(r) => r.id}
      storageKey={SLOW_OPS_LOCAL}
      defaultView="table"
      actions={refresh}
      emptyState="No slow operations recorded"
    />
  );
}
