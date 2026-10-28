import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";

// Trip default for the compressor-thrash onset signal
// (research/2026-07-11-global-fleet-memory-admission-duress-valve.md, D6):
// the two forensicated 2026-07-11 freezes ran 240k–442k decompressions/s,
// healthy baseline ≈0, benign bursts a few k/s. Calibratable — replay the
// 07-11 episodes on the Timeline tab before freezing it.
const DEFAULT_ON_DECOMPRESSIONS_PER_SEC = 50_000;

// Sentinel knobs (the traceConfig template). The sampler fields take effect on
// the next backend restart (the interval is created once); the detector
// thresholds (Phase B4) are watched live (watchConfig pushes them to the
// sentinel worker), so tuning them is live. Defaults are educated guesses to
// be calibrated against the replayed 2026-07-10 09:03–09:21Z burst on the
// Debug → Slow Events → Timeline tab.
export const sentinelConfig = defineConfig({
  name: "sentinel",
  fields: {
    enabled: boolField({
      default: true,
      label: "Enabled",
      description:
        "When off, the cluster sentinel sampler does not run (main backend, restart to apply).",
    }),
    cadenceMs: intField({
      default: 5_000,
      min: 1_000,
      label: "Sample cadence (ms)",
      description:
        "How often the sentinel samples cluster vitals (restart to apply). The 'cluster' trace ring holds 720 samples (1h at 5s).",
    }),
    onLocksWaiting: intField({
      default: 5,
      min: 0,
      label: "Onset: ungranted pg locks",
      description: "Trip signal: this many ungranted Postgres locks cluster-wide.",
    }),
    onBlkReadDeltaMs: intField({
      default: 2_000,
      min: 0,
      label: "Onset: blk_read_time delta (ms/tick)",
      description:
        "Trip signal: Postgres block-read time burned across the cluster in one tick.",
    }),
    onBackendP99Ms: intField({
      default: 1_000,
      min: 0,
      label: "Onset: backend event-loop p99 (ms)",
      description:
        "A backend counts as slow when its latest health sample's event-loop p99 exceeds this.",
    }),
    onSlowBackends: intField({
      default: 2,
      min: 1,
      label: "Onset: slow-backend count",
      description: "Trip signal: at least this many backends slow at once.",
    }),
    onDecompressionsPerSec: intField({
      default: DEFAULT_ON_DECOMPRESSIONS_PER_SEC,
      min: 0,
      label: "Onset: decompressions/s",
      description:
        "Trip signal: macOS memory-compressor decompressions per second (from the host sampler). The freezes ran 240k–442k/s; healthy baseline is ~0.",
    }),
    onTicks: intField({
      default: 3,
      min: 1,
      label: "Onset dwell (ticks)",
      description:
        "Consecutive elevated ticks required before the onset trips (hysteresis).",
    }),
    offRatio: floatField({
      default: 0.6,
      label: "Clear ratio",
      description:
        "Clear thresholds are the trip thresholds multiplied by this (dual-threshold hysteresis).",
    }),
    offTicks: intField({
      default: 6,
      min: 1,
      label: "Clear dwell (ticks)",
      description:
        "Consecutive calm ticks (all signals below the clear thresholds) required before the episode clears.",
    }),
    maxEpisodeHoldMs: intField({
      default: 1_800_000,
      min: 60_000,
      label: "Max episode hold (ms)",
      description:
        "Safety bound on a duress episode: past this, the sentinel worker force-clears the latch and re-evaluates from scratch (a mis-calibrated threshold cannot latch the fleet indefinitely). A forced clear re-grants shed first-N on the re-trip.",
    }),
  },
});
