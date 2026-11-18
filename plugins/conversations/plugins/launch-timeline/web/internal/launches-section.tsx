import type { ReactElement } from "react";
import { formatDuration } from "@plugins/debug/plugins/profiling/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import {
  checkoutStepStats,
  conversationLaunches,
  segmentStats,
  type LaunchRecord,
  type Percentiles,
} from "../../core";

/** One stretch's percentiles over all launches, and split by how the checkout was made. */
interface SegmentRow {
  id: string;
  label: string;
  total: boolean;
  all: Percentiles;
  spare: Percentiles;
  fresh: Percentiles;
}

function ms(v: number | null): string {
  return v === null ? "—" : formatDuration(v);
}

function percentileColumns<R>(
  prefix: string,
  heading: string,
  of: (r: R) => Percentiles,
): ColumnDef<R>[] {
  return [
    {
      id: `${prefix}-p50`,
      header: `${heading} p50`,
      align: "end",
      width: "7rem",
      value: (r) => of(r).p50 ?? -1,
      cell: (r) => ms(of(r).p50),
    },
    {
      id: `${prefix}-p90`,
      header: `${heading} p90`,
      align: "end",
      width: "7rem",
      value: (r) => of(r).p90 ?? -1,
      cell: (r) => ms(of(r).p90),
    },
    {
      id: `${prefix}-n`,
      header: `${heading} n`,
      align: "end",
      width: "4rem",
      value: (r) => of(r).n,
    },
  ];
}

const SEGMENT_COLUMNS: ColumnDef<SegmentRow>[] = [
  {
    id: "label",
    header: "Stretch",
    value: (r) => r.label,
    cell: (r) => (r.total ? <strong>{r.label}</strong> : r.label),
  },
  ...percentileColumns<SegmentRow>("all", "All", (r) => r.all),
  ...percentileColumns<SegmentRow>("spare", "Spare", (r) => r.spare),
  ...percentileColumns<SegmentRow>("fresh", "Fresh", (r) => r.fresh),
];

type StepRow = Percentiles & { step: string };

const STEP_COLUMNS: ColumnDef<StepRow>[] = [
  { id: "step", header: "Checkout step", value: (r) => r.step },
  ...percentileColumns<StepRow>("all", "All", (r) => r),
];

function segmentRows(launches: readonly LaunchRecord[]): SegmentRow[] {
  const all = segmentStats(launches);
  const spare = segmentStats(
    launches.filter((l) => l.checkoutSource === "spare"),
  );
  const fresh = segmentStats(
    launches.filter((l) => l.checkoutSource === "fresh"),
  );
  return all.map((s, i) => ({
    id: s.id,
    label: s.label,
    total: s.total,
    all: s,
    spare: spare[i]!,
    fresh: fresh[i]!,
  }));
}

function LaunchStats({
  launches,
}: {
  launches: readonly LaunchRecord[];
}): ReactElement {
  return (
    <Inset pad="lg">
      <Stack gap="lg">
        <Stack as="section" gap="sm">
          <SectionLabel>
            Agent launches — the newest {launches.length}, request to first
            token (spare: a claimed spare checkout; fresh: a cold one)
          </SectionLabel>
          <DataTable
            data={segmentRows(launches)}
            columns={SEGMENT_COLUMNS}
            rowKey={(r) => r.id}
            emptyLabel="No launch recorded yet."
          />
        </Stack>
        <Stack as="section" gap="sm">
          <SectionLabel>
            Checkout steps (the worktree.prepare child)
          </SectionLabel>
          <DataTable
            data={checkoutStepStats(launches)}
            columns={STEP_COLUMNS}
            rowKey={(r) => r.step}
            emptyLabel="No checkout recorded yet."
          />
        </Stack>
      </Stack>
    </Inset>
  );
}

/**
 * Per-stretch p50 / p90 of the newest agent launches, from their launch
 * records — live, so a launch shows as it reaches each phase.
 */
export function LaunchesSection(): ReactElement {
  const result = useLive(conversationLaunches);
  switch (result.status) {
    case "loading":
      return (
        <Inset pad="lg">
          <Loading variant="block" />
        </Inset>
      );
    case "error":
      return (
        <Inset pad="lg">
          <ResourceErrorInline
            variant="block"
            subject="the agent launches"
            error={result.error}
            refetch={result.refetch}
          />
        </Inset>
      );
    case "ready":
      return <LaunchStats launches={result.data} />;
  }
}
