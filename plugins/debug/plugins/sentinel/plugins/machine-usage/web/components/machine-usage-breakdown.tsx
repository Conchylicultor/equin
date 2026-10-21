import type { CSSProperties } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { machineUsage, type MachineUsageBucket } from "../../core";
import {
  machineUsageView,
  type BucketView,
  type MachineUsageView,
} from "../internal/machine-usage-view";

// The Machine watcher card's "Where it goes": the machine's CPU and memory as
// two bars split by who the processes work for, then one line per bucket. One
// reading per opening (the value samples on subscribe), mounted only while the
// card is expanded.
//
// Not a DataView: four fixed buckets are a closed set, not domain records, and
// nothing here is clickable.

/**
 * Each bucket's fill. Theme tokens only: the categorical palette (distinct
 * hues, so four buckets side by side in one bar stay tellable apart), and a
 * neutral for the rest.
 */
const BUCKET_FILL: Record<MachineUsageBucket, CSSProperties> = {
  chrome: { background: "var(--categorical-1)" },
  "agent-ops": { background: "var(--categorical-5)" },
  "agent-browser": { background: "var(--categorical-2)" },
  other: { background: "var(--categorical-10)" },
};

/** Fixed columns, so the bars and the numbers line up row to row. */
const VALUE_COL = cn(rigidClass(), "w-14 text-right tabular-nums");

function StackedBar({
  label,
  buckets,
  share,
  total,
}: {
  label: string;
  buckets: BucketView[];
  share: (b: BucketView) => number;
  total: string;
}) {
  return (
    <Line className="gap-md">
      <Text variant="caption" tone="faint" className={cn(rigidClass(), "w-8")}>
        {label}
      </Text>
      <Fill>
        <Clip aria-hidden className="h-1.5 rounded-full bg-muted-foreground/15">
          <Line className="h-full gap-px">
            {buckets.map((b) => (
              <div
                key={b.bucket}
                className={cn(rigidClass(), "h-full")}
                style={{
                  ...BUCKET_FILL[b.bucket],
                  width: `${String(share(b) * 100)}%`,
                }}
              />
            ))}
          </Line>
        </Clip>
      </Fill>
      <Text variant="caption" tone="muted" className={VALUE_COL}>
        {total}
      </Text>
    </Line>
  );
}

export function MachineUsageBreakdownView({
  view,
}: {
  view: MachineUsageView;
}) {
  return (
    <Stack gap="sm" data-machine-usage>
      <Stack gap="xs">
        <StackedBar
          label="CPU"
          buckets={view.buckets}
          share={(b) => b.cpuShare}
          total={view.cpuTotalText}
        />
        <StackedBar
          label="RAM"
          buckets={view.buckets}
          share={(b) => b.memShare}
          total={view.memTotalText}
        />
      </Stack>
      <Stack gap="none">
        {view.buckets.map((b) => (
          <Line
            key={b.bucket}
            className="gap-md"
            title={b.hint}
            data-machine-usage-bucket={b.bucket}
          >
            <span
              aria-hidden
              className={cn(rigidClass(), "size-2 rounded-xs")}
              style={BUCKET_FILL[b.bucket]}
            />
            <Fill>
              <Text variant="caption" className="truncate">
                {b.label}
              </Text>
            </Fill>
            <Text variant="caption" tone="muted" className={VALUE_COL}>
              {b.cpuText}
            </Text>
            <Text variant="caption" tone="muted" className={VALUE_COL}>
              {b.memText}
            </Text>
          </Line>
        ))}
      </Stack>
      <Text variant="caption" tone="faint">
        CPU of all cores · RAM {view.memOfText} · as of {view.atText}
      </Text>
    </Stack>
  );
}

export function MachineUsageBreakdown() {
  const result = useLive(machineUsage);
  if (result.status === "loading") {
    return <Loading label="Measuring where CPU and memory go…" />;
  }
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="where the machine's CPU and memory go"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  return <MachineUsageBreakdownView view={machineUsageView(result.data)} />;
}
