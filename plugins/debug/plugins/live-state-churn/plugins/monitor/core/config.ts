import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";

// Tunable thresholds for the live-state churn monitor. The scheduled monitor job
// reads these live via getConfig each tick, so changes take effect on the next
// run without a restart.
//
// A resource is judged by the WORK its no-op recomputes waste, not by how many
// there are: a recompute's own work (its thread and the database answering it)
// plus the io it waited on (a git child, a file read) — never the time it
// queued on a gate or joined another run, which costs it nothing. Why 1000 ms
// per minute (≈1.7% of one core): measured on main (2026-11-14), the resources
// that churn today waste far less — `tasks.tree.v2:groups` ~3 ms own per
// recompute at its worst reported 3.1 no-op/s ≈ 560 ms/min (≈130 ms/min over a
// typical 10 min), `tasks.tree.v2` ~2 ms at 1/s ≈ 120 ms/min, `pages.tree.v2`
// and `conversations-active` below that. A count threshold (1/s) filed all of
// them and two investigations found nothing worth fixing. At 1000 ms/min a
// 3 ms recompute must churn at ~5.5/s to file, and a 2 s one files at one no-op
// a minute.
export const liveStateChurnConfig = defineConfig({
  name: "live-state-churn",
  fields: {
    enabled: boolField({
      default: true,
      label: "Enabled",
      description:
        "When off, the monitor job returns early and files no live-state churn reports.",
    }),
    wastedMsPerMinuteThreshold: floatField({
      default: 1000,
      min: 0,
      label: "Wasted work threshold (ms per minute)",
      description:
        "File a live-state-noop report when a resource's no-op (empty-diff) recomputes waste this much work per minute over the window — their own work (server thread + database) plus the git / file io they waited on. Time spent queued on a gate or joining another run is not counted.",
    }),
    windowSeconds: intField({
      default: 60,
      min: 1,
      label: "Window (seconds)",
      description: "Sliding window over which the wasted work is measured.",
    }),
  },
});
