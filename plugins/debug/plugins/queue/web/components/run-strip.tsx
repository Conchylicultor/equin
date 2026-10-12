import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { formatDuration, formatWhen } from "../internal/format";
import { isActive, type JobListRow } from "../internal/job-rows";
import { STATUS_META } from "../internal/status";
import { DetailSection } from "./detail-kit";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";

/**
 * "Recent runs of this job": every row of the same job — its recorded runs
 * oldest → newest, then whatever is in flight — as small bars, height by the
 * square root of the duration (so one long run does not flatten the rest),
 * coloured by outcome; in-flight rows striped. A bar links to its row.
 */
export function RunStrip({
  rows,
  current,
  runTarget,
}: {
  /** Every Jobs row of this job name. */
  rows: readonly JobListRow[];
  current: string;
  runTarget: (key: string) => LinkTarget;
}) {
  const now = useNow(10_000);
  const done = rows
    .filter((r) => r.kind === "run")
    .sort((a, b) => a.when.getTime() - b.when.getTime());
  const inFlight = rows.filter((r) => isActive(r));
  const bars = [...done, ...inFlight];
  const maxMs = Math.max(1, ...bars.map((r) => r.durationMs ?? 0));
  const failed = done.filter((r) => r.status === "failed").length;
  const lastSuccess = done.filter((r) => r.status === "succeeded").at(-1);
  return (
    <DetailSection label="Recent runs of this job" count="oldest → newest">
      <Stack gap="sm">
        {/* eslint-disable-next-line layout/no-adhoc-layout -- a bar chart's baseline: bars stand on the bottom edge (items-end), each height a runtime percentage */}
        <div className="flex h-14 items-end gap-2xs rounded-md border border-border bg-muted px-xs pt-xs">
          {bars.map((r) => {
            const height =
              r.durationMs === null
                ? 30
                : Math.max(8, Math.sqrt(r.durationMs / maxMs) * 100);
            const meta = STATUS_META[r.status];
            const title = [
              meta.label,
              formatWhen(r.when, now),
              r.durationMs === null ? null : formatDuration(r.durationMs),
            ]
              .filter((s) => s !== null)
              .join(" · ");
            return (
              <button
                key={r.key}
                type="button"
                title={title}
                aria-label={title}
                aria-current={r.key === current ? "true" : undefined}
                {...activationProps(runTarget(r.key))}
                style={{ height: `${height}%` }}
                className={cn(
                  // Bars share the strip's width, between a hairline and 12px.
                  growClass(),
                  "min-w-1 max-w-3 rounded-t-sm opacity-80 hover:opacity-100",
                  isActive(r) ? (STRIPED[r.status] ?? meta.dot) : meta.dot,
                  r.key === current &&
                    "opacity-100 outline outline-2 outline-offset-1 outline-foreground",
                )}
              />
            );
          })}
        </div>
        <Cluster gap="md">
          <Stat value={String(done.length)} label="runs" />
          <Stat
            value={String(failed)}
            label="failed"
            tone={failed > 0 ? "destructive" : undefined}
          />
          <Stat value={String(inFlight.length)} label="in flight" />
          <Stat
            value={
              lastSuccess === undefined
                ? "never"
                : formatWhen(lastSuccess.when, now)
            }
            label="last success"
            valueFirst={false}
          />
        </Cluster>
      </Stack>
    </DetailSection>
  );
}

// In-flight bars: the status colour, striped so "not finished" reads apart
// from a finished bar of the same colour.
const STRIPED: Partial<Record<JobListRow["status"], string>> = {
  pending:
    "bg-[repeating-linear-gradient(135deg,var(--info)_0_3px,transparent_3px_6px)]",
  running:
    "bg-[repeating-linear-gradient(135deg,var(--warning)_0_3px,transparent_3px_6px)]",
  retrying:
    "bg-[repeating-linear-gradient(135deg,var(--warning)_0_3px,transparent_3px_6px)]",
};

function Stat({
  value,
  label,
  tone,
  valueFirst = true,
}: {
  value: string;
  label: string;
  tone?: "destructive";
  valueFirst?: boolean;
}) {
  const v = (
    <Text variant="caption" tone={tone ?? "strong"} className="tabular-nums">
      {value}
    </Text>
  );
  const l = (
    <Text variant="caption" tone="muted">
      {label}
    </Text>
  );
  return (
    <Cluster gap="xs">
      {valueFirst ? v : l}
      {valueFirst ? l : v}
    </Cluster>
  );
}
