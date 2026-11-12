import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

/**
 * The epoch handoff's switch (`../../machine`): on, a backend replaced by a
 * successor hands it the tuples it vouched for, and the successor answers a
 * replayed sub `up-to-date` with no read; off, nothing is written or
 * inherited, and every replayed sub after a restart loads — the cold restart.
 *
 * The handoff is a complement, never the reason a restart is cheap: the
 * restart-storm benchmark (`debug/profiling/restart-storm`) measures the cold
 * case with it off, and the on case only as a diagnostic. Both halves read it
 * at call time — the old backend as it shuts down, its successor as the first
 * replayed sub arrives — so turning it off takes effect on the next restart.
 */
export const liveStateHandoffConfig = defineConfig({
  name: "live-state-handoff",
  fields: {
    enabled: boolField({
      default: true,
      label: "Hand live state over across restarts",
      description:
        "When on, a restarting server hands its open tabs' live data to its successor, which then reloads only what changed. Turn off to measure a cold restart: every open tab's data reloads.",
    }),
  },
});
