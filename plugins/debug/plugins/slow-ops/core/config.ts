import { defineConfig, type ConfigValues } from "@plugins/config_v2/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import type { ClientLatencySignal } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";

// Per-signal slow-op thresholds (milliseconds). All of them render for free in the
// Settings → Config UI; both the server span hook and the client collector read
// them live (server via watchConfig, client via useConfig) so changes take
// effect without a restart.
export const slowOpConfig = defineConfig({
  name: "slow-op",
  fields: {
    pageLoadMs: intField({
      default: 2000,
      min: 0,
      label: "Page load threshold (ms)",
      description:
        "Report a slow-op when first content paint takes longer than this (measured client-side in a post-paint frame).",
    }),
    elementMs: intField({
      default: 1000,
      min: 0,
      label: "Element appearance threshold (ms)",
      description:
        "Report a slow-op when a live-state resource takes longer than this to settle (mount → first data).",
    }),
    // An in-browser server's boot (a demo's worker: page asks → host ready) is
    // filed once per boot against this budget — never on the reads, which
    // mount only once it is ready. Sized from main's boots over 24 h
    // (2026-11-12, 94 boots): median 3.0 s, p75 4.3 s, p90 6.3 s — a boot
    // regressing toward the 19–41 s tail fires.
    browserHostBootMs: intField({
      default: 5000,
      min: 0,
      label: "In-browser server boot budget (ms)",
      description:
        "Report a slow-op when an in-browser server (a demo's worker) takes longer than this from the page asking for it to it being ready — filed once per boot.",
    }),
    updateMs: intField({
      default: 1000,
      min: 0,
      label: "Live update threshold (ms)",
      description:
        "Report a slow-op when a server-side change takes longer than this to reach a visible tab's cache (change → pushed frame applied).",
    }),
    confirmMs: intField({
      default: 2000,
      min: 0,
      label: "Write confirm threshold (ms)",
      description:
        "Report a slow-op when an optimistic write takes longer than this to be confirmed by the server (dispatch → confirmed), in a visible tab.",
    }),
    loaderMs: intField({
      default: 2000,
      min: 0,
      label: "Loader threshold (ms)",
      description:
        "Report a slow-op when a server resource loader span exceeds this duration.",
    }),
    httpMs: intField({
      default: 2000,
      min: 0,
      label: "HTTP threshold (ms)",
      description:
        "Report a slow-op when a server HTTP request span exceeds this duration.",
    }),
    dbMs: intField({
      default: 500,
      min: 0,
      label: "DB query threshold (ms)",
      description:
        "Report a slow-op when a database query span exceeds this duration.",
    }),
    jobMs: intField({
      default: 3000,
      min: 0,
      label: "Job threshold (ms)",
      description:
        "Report a slow-op when a background job run exceeds this duration. A job can override this via defineJob({ slowThresholdMs }).",
    }),
    // A gate's window (the leftover waits of independent ops over a minute,
    // summed) is not a latency anyone felt: by Little's law it is the gate's
    // mean queue depth × the window. So it is judged on depth, not on the
    // per-op `loaderMs` bar — that bar made 300 reads a minute waiting ~7 ms
    // each (mean depth ~0.035) a "slow" gate. Measured on main over 24 h
    // (2026-11-12): every boot storm's busiest minute on `read-admit` held a
    // mean depth ≥ 0.57 (34–1570 s of waits); steady minutes ~0.035.
    gateQueueDepth: floatField({
      default: 0.25,
      min: 0,
      label: "Gate queue depth (mean waiters)",
      description:
        "Report a congested gate when, over its one-minute window, the requests no single slow-op covered kept on average more than this many waiters queued on it (summed wait ÷ window). One wait, or one request's waits summed, is still judged on the loader threshold.",
    }),
  },
});

type SlowOpThresholds = ConfigValues<(typeof slowOpConfig)["fields"]>;

/**
 * Which threshold judges each client latency signal (latency-signal's closed
 * vocabulary). A Record over the signal union, so a new signal does not compile
 * until it names its knob here — the collector never names a signal itself.
 *
 * These are CLIENT thresholds: they must stay out of the server's
 * `perfFloorMs` (server/internal/resolve-threshold.ts), which lists the
 * server-span knobs by name. A client knob there would lower the profiler's
 * floor for every server span without any server span ever being judged by it.
 */
export const CLIENT_SIGNAL_THRESHOLD: Record<
  ClientLatencySignal,
  keyof SlowOpThresholds
> = {
  update: "updateMs",
  confirm: "confirmMs",
  // A message shown is a change reaching a tab: the live-update bar.
  "turn-echo": "updateMs",
};
