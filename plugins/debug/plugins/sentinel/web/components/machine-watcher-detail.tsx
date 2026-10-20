import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { MachineUsageBreakdown } from "@plugins/debug/plugins/sentinel/plugins/machine-usage/web";
import { sentinelVitals, type SentinelVitals } from "../../core";
import { FILL_CLASS, STALE_CLASS, VALUE_CLASS } from "../internal/vitals-tone";
import {
  vitalsView,
  type SignalLineView,
  type VitalsView,
} from "../internal/vitals-view";

// The Machine watcher row's expanded detail: one line per signal that can put
// the machine under duress — a bar toward its limit and the words "X of LIMIT"
// — then where the machine's CPU and memory go (machine-usage), then one
// sentence of context. Mounted only while the row is expanded.
//
// Not a DataView: five fixed signals are a closed set, not domain records, and
// nothing here is clickable.

/** The bar toward a signal's limit. Presentational; the words beside it carry the value. */
function SignalMeter({
  fraction,
  tone,
}: {
  fraction: number;
  tone: SignalLineView["tone"];
}) {
  return (
    <Clip
      aria-hidden
      className={cn(
        rigidClass(),
        "h-1 w-16 rounded-full bg-muted-foreground/15",
      )}
    >
      <div
        className={cn("h-full rounded-full", FILL_CLASS[tone])}
        style={{ width: `${String(Math.round(fraction * 100))}%` }}
      />
    </Clip>
  );
}

function SignalLine({ line, stale }: { line: SignalLineView; stale: boolean }) {
  const tone = stale ? "neutral" : line.tone;
  return (
    <Line className="gap-md" data-vitals-signal={line.key} data-tone={tone}>
      <Fill>
        <Text variant="caption" tone={tone === "neutral" ? "muted" : "default"}>
          {line.label}
        </Text>
      </Fill>
      <SignalMeter fraction={line.fraction} tone={tone} />
      <Text
        variant="caption"
        tone="faint"
        className={cn(rigidClass(), "text-right tabular-nums")}
      >
        <span className={cn("font-semibold", VALUE_CLASS[tone])}>
          {line.valueText}
        </span>{" "}
        of {line.limitText}
      </Text>
    </Line>
  );
}

export function RecordedDetail({ view }: { view: VitalsView }) {
  return (
    <Stack gap="sm" className={view.stale ? STALE_CLASS : undefined}>
      <Stack gap="xs">
        {view.signals.map((line) => (
          <SignalLine key={line.key} line={line} stale={view.stale} />
        ))}
      </Stack>
      <Stack gap="xs" className="border-t border-border pt-sm">
        <Text
          variant="caption"
          tone="faint"
          className="uppercase tracking-wide"
        >
          Where it goes
        </Text>
        <MachineUsageBreakdown />
      </Stack>
      <Text variant="caption" tone="muted" data-vitals-footer>
        {view.footer}
      </Text>
    </Stack>
  );
}

/** The detail for any settled vitals read, at `now`. */
export function MachineWatcherDetailView({
  vitals,
  now,
}: {
  vitals: SentinelVitals;
  now: number;
}) {
  switch (vitals.kind) {
    case "none":
      return (
        <Text variant="caption" tone="muted">
          The machine watcher has not recorded a reading on this machine yet.
        </Text>
      );
    case "unreadable":
      return (
        <Text variant="caption" tone="muted">
          The machine watcher&apos;s latest reading is unreadable:{" "}
          {vitals.reason}
        </Text>
      );
    case "recorded":
      return (
        <RecordedDetail view={vitalsView(vitals.vitals, vitals.current, now)} />
      );
  }
}

export function MachineWatcherDetail() {
  const result = useLive(sentinelVitals);
  // Drives "Updated 3s ago" and notices a reading going stale between pushes.
  const now = useNow(1_000);
  if (result.status === "loading") {
    return <Loading label="Reading the machine watcher…" />;
  }
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the machine watcher's latest reading"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  return <MachineWatcherDetailView vitals={result.data} now={now} />;
}
