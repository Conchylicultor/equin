import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  insetClass,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { sentinelVitals } from "../../core";
import { VALUE_CLASS, STALE_CLASS } from "../internal/vitals-tone";
import {
  vitalsView,
  type BannerView,
  type VitalsView,
} from "../internal/vitals-view";

// The Machine watcher row's glance: load per core, available memory and builds under
// the summary, plus a banner naming what tripped the watcher (or saying the
// numbers are old). It sits inside the row's click target, so it holds no
// controls. Subscribes to the per-tick vitals — mounted only while the health
// report is open, so a closed report receives no vitals at all.

const BANNER_CLASS: Record<BannerView["kind"], string> = {
  tripped: cn("bg-destructive/10 text-destructive"),
  stale: cn("bg-muted text-muted-foreground"),
};

/** How often the glance re-checks whether its reading went stale. */
const STALE_CHECK_MS = 5_000;

export function MachineWatcherGlanceView({ view }: { view: VitalsView }) {
  return (
    <Stack gap="xs" data-vitals-stale={view.stale || undefined}>
      <Cluster gap="sm" className={view.stale ? STALE_CLASS : undefined}>
        {view.glance.map((figure) => (
          <Text
            key={figure.key}
            variant="caption"
            tone="muted"
            className="whitespace-nowrap tabular-nums"
            data-vitals-figure={figure.key}
          >
            {figure.before}
            <span
              className={cn(
                "font-semibold",
                VALUE_CLASS[view.stale ? "neutral" : figure.tone],
              )}
            >
              {figure.value}
            </span>
            {figure.after}
          </Text>
        ))}
      </Cluster>
      {view.banner ? (
        <Text
          variant="caption"
          className={cn(
            "rounded-md",
            insetClass({ x: "sm", y: "xs" }),
            BANNER_CLASS[view.banner.kind],
          )}
          data-vitals-banner={view.banner.kind}
        >
          {view.banner.text}
        </Text>
      ) : null}
    </Stack>
  );
}

export function MachineWatcherGlance() {
  const result = useLive(sentinelVitals);
  const now = useNow(STALE_CHECK_MS);
  // Loading, failed, or nothing readable: nothing here. The summary above
  // already carries the verdict (a failed read says so there), and the
  // expanded detail says why there are no numbers.
  if (result.status === "loading" || result.status === "error") return null;
  if (result.data.kind !== "recorded") return null;
  const { vitals, current } = result.data;
  return <MachineWatcherGlanceView view={vitalsView(vitals, current, now)} />;
}
