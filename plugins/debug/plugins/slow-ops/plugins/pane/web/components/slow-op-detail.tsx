import { useMemo, type ReactElement, type ReactNode } from "react";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import {
  slowOpById,
  slowOpCallers,
  type SlowOpCaller,
  type SlowOp,
  type SlowOpMeasures,
  type SlowOpSample,
  type VariantBreakdown,
} from "@plugins/debug/plugins/slow-ops/core";
import {
  SPAN_MEASURES,
  type SpanMeasure,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

// Markers scraped by codegen (data-views.generated.ts). Must live in web/**.
const SLOW_OP_CALLERS = defineDataView("debug.slow-op.callers");
const SLOW_OP_SAMPLES = defineDataView("debug.slow-op.samples");

// Every caller of every op, read scoped to the open op. Paged by total time
// from the server, so an op with hundreds of callers still opens instantly and
// every one of them stays named.
const callersSource = liveDataSource(slowOpCallers, {
  searchable: ["callerLabel"],
  facets: ["callerKind"],
});

const ms = (v: number): string => `${Math.round(v)} ms`;

// One slow op, read by id from the `slow-ops.op` lookup: live, so a new
// occurrence of this op lands within the producer's 2 s window.
export function SlowOpDetail({ id }: { id: string }): ReactElement {
  const result = useLiveRow(slowOpById, id);

  if (result.status === "loading") {
    return (
      <Center axis="both" className="h-full">
        <Loading />
      </Center>
    );
  }
  if (result.status === "error") {
    return (
      <Center axis="both" className="h-full p-2xl text-center">
        <ResourceErrorInline
          variant="block"
          subject="the slow op"
          error={result.error}
          refetch={result.refetch}
        />
      </Center>
    );
  }
  if (!result.found) {
    return (
      <Center axis="both" className="h-full p-2xl text-center">
        <Placeholder tone="muted">
          {`No slow op with id "${id}" — it may have aged out (30 days after its last occurrence).`}
        </Placeholder>
      </Center>
    );
  }
  return <SlowOpBody op={result.row} />;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="border-b px-lg py-sm">
      <Stack gap="xs">
        <Text as="div" variant="caption" tone="muted">
          {title}
        </Text>
        {children}
      </Stack>
    </div>
  );
}

function SlowOpBody({ op }: { op: SlowOp }): ReactElement {
  const traceId = op.recentSamples[0]?.traceId;
  const waits = Object.entries(op.waits).sort((a, b) => b[1] - a[1]);
  const variants = [...op.variants].sort((a, b) => b.totalMs - a.totalMs);
  const hasMeasures = SPAN_MEASURES.some((m) => op.measures[m]);
  return (
    <Stack gap="none">
      <div className="border-b px-lg py-sm">
        <Stack gap="xs">
          <Stack direction="row" gap="xs" align="center">
            <Badge variant="muted" mono>
              {op.operationKind}
            </Badge>
            {traceId && (
              <LinkChip
                leading={<Icon icon={boltIcon} className="icon-auto" />}
                activation={appLink(
                  traceDetailRoute.link(debugApp, { id: traceId }),
                )}
              >
                newest trace
              </LinkChip>
            )}
          </Stack>
          <Text as="div" variant="code" className="break-all">
            {op.operation}
          </Text>
          <Text as="div" variant="caption" tone="muted">
            {`${op.count}× · total ${ms(op.totalMs)} · max ${ms(op.maxMs)} · last ${ms(op.lastMs)} (threshold ${ms(op.thresholdMs)})`}
          </Text>
          <Text as="div" variant="caption" tone="muted">
            First seen <RelativeTime date={op.firstSeenAt} /> · last seen{" "}
            <RelativeTime date={op.lastSeenAt} />
          </Text>
        </Stack>
      </div>

      <Section title="Callers">
        <CallersView
          operationKind={op.operationKind}
          operation={op.operation}
        />
      </Section>

      {waits.length > 0 && (
        <Section title="Waits by layer">
          <WaitLines waits={waits} />
        </Section>
      )}

      {variants.length > 0 && (
        <Section title="Variants">
          <VariantLines variants={variants} />
        </Section>
      )}

      {hasMeasures && (
        <Section title="Measures">
          <MeasureLines measures={op.measures} />
        </Section>
      )}

      <Section title="Recent samples">
        <SamplesView samples={op.recentSamples} />
      </Section>
    </Stack>
  );
}

const callerFields: FieldDef<SlowOpCaller>[] = [
  {
    id: "callerKind",
    label: "Kind",
    type: "enum",
    value: (r) => r.callerKind,
    cell: (r) => (
      <Badge variant="muted" mono>
        {r.callerKind}
      </Badge>
    ),
    sortable: false,
    filterable: true,
    width: "6rem",
  },
  {
    id: "callerLabel",
    label: "Caller",
    type: "text",
    primary: true,
    value: (r) => r.callerLabel,
    cell: (r) => (
      <Text
        as="span"
        variant="caption"
        className="truncate font-mono"
        title={r.callerLabel}
      >
        {r.callerLabel}
      </Text>
    ),
    sortable: false,
    filterable: true,
    width: "minmax(0,1fr)",
  },
  {
    id: "count",
    label: "Count",
    type: "number",
    value: (r) => r.count,
    sortable: true,
    filterable: false,
    align: "end",
    width: "4rem",
  },
  {
    id: "totalMs",
    label: "Total (ms)",
    type: "number",
    value: (r) => r.totalMs,
    cell: (r) => <span className="tabular-nums">{Math.round(r.totalMs)}</span>,
    sortable: true,
    filterable: false,
    align: "end",
    width: "5.5rem",
  },
  {
    id: "maxMs",
    label: "Max (ms)",
    type: "number",
    value: (r) => r.maxMs,
    cell: (r) => <span className="tabular-nums">{Math.round(r.maxMs)}</span>,
    sortable: true,
    filterable: false,
    align: "end",
    width: "5rem",
  },
  {
    id: "lastSeenAt",
    label: "Last seen",
    type: "date",
    value: (r) => r.lastSeenAt,
    cell: (r) => <RelativeTime date={r.lastSeenAt} />,
    sortable: true,
    filterable: false,
    align: "end",
    width: "6rem",
  },
];

// This op's callers: the `slow-ops.callers` window scoped to the op's key,
// stated as data (never a filter the user's Filter control could widen).
function CallersView({
  operationKind,
  operation,
}: {
  operationKind: string;
  operation: string;
}): ReactElement {
  const source = useMemo(
    () => callersSource.scoped({ where: { operationKind, operation } }),
    [operationKind, operation],
  );
  return (
    <DataView<SlowOpCaller>
      fields={callerFields}
      source={source}
      storageKey={SLOW_OP_CALLERS}
      views={["table"]}
      defaultView="table"
      emptyState="No caller recorded (page loads carry none)."
    />
  );
}

interface SampleRow extends SlowOpSample {
  key: string;
}

const sampleFields: FieldDef<SampleRow>[] = [
  {
    id: "atTime",
    label: "When",
    type: "date",
    value: (r) => r.atTime,
    cell: (r) => <RelativeTime date={r.atTime} />,
    width: "6rem",
  },
  {
    id: "durationMs",
    label: "Duration",
    type: "number",
    value: (r) => r.durationMs,
    cell: (r) => <span className="tabular-nums">{ms(r.durationMs)}</span>,
    align: "end",
    width: "5.5rem",
  },
  {
    id: "load",
    label: "Load / cores",
    type: "text",
    value: (r) => `${r.snapshot.loadAvg1.toFixed(1)} / ${r.snapshot.cpuCount}`,
    width: "6rem",
  },
  {
    id: "pg",
    label: "PG active / total",
    type: "text",
    value: (r) =>
      `${r.snapshot.pgActiveBackends} / ${r.snapshot.pgTotalBackends}`,
    width: "7rem",
  },
  {
    id: "variant",
    label: "Variant",
    type: "text",
    primary: true,
    value: (r) => r.variant ?? "",
    cell: (r) => (
      <Text
        as="span"
        variant="caption"
        className="truncate font-mono"
        title={r.variant}
      >
        {r.variant ?? ""}
      </Text>
    ),
    width: "minmax(0,1fr)",
  },
  {
    id: "trace",
    label: "Trace",
    type: "text",
    value: (r) => r.traceId ?? "",
    cell: (r) =>
      r.traceId ? (
        <LinkChip
          leading={<Icon icon={boltIcon} className="icon-auto" />}
          activation={appLink(
            traceDetailRoute.link(debugApp, { id: r.traceId }),
          )}
        >
          trace
        </LinkChip>
      ) : null,
    width: "5rem",
  },
];

// The newest 10 occurrences with the box state each tripped in.
function SamplesView({ samples }: { samples: SlowOpSample[] }): ReactElement {
  const rows = useMemo<SampleRow[]>(
    () =>
      samples.map((s, i) => ({
        ...s,
        key: `${new Date(s.atTime).getTime()}:${i}`,
      })),
    [samples],
  );
  return (
    <DataView<SampleRow>
      rows={rows}
      fields={sampleFields}
      rowKey={(r) => r.key}
      storageKey={SLOW_OP_SAMPLES}
      views={["table"]}
      defaultView="table"
      emptyState="No samples."
    />
  );
}

// The durable wait-vs-work split: ⏳ heavy-read-acquire 3500 ms. Surfaces
// head-of-line blocking / lock-vs-work without manual repro.
function WaitLines({ waits }: { waits: [string, number][] }): ReactElement {
  return (
    <Stack gap="2xs">
      {waits.map(([layer, total]) => (
        <span
          key={layer}
          className="truncate font-mono text-3xs text-muted-foreground"
          title={`${layer}: ${Math.round(total)}ms wait`}
        >
          ⏳ {layer} {ms(total)}
        </span>
      ))}
    </Stack>
  );
}

// Which instances of the operation were slow (a loader's params): ◇ {"id":"…"}
// ×3 (4200 ms). Slowest total first; the folded tail reads as "(other)".
function VariantLines({
  variants,
}: {
  variants: VariantBreakdown[];
}): ReactElement {
  return (
    <Stack gap="2xs">
      {variants.map((v) => (
        <span
          key={v.variant}
          className="truncate font-mono text-3xs text-muted-foreground"
          title={v.variant}
        >
          ◇ {v.variant} ×{v.count} ({ms(v.totalMs)})
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
    <Stack gap="2xs">
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
