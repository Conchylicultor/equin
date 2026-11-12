import { implement } from "@plugins/infra/plugins/endpoints/server";
import { runInBackgroundLane } from "@plugins/infra/plugins/runtime-profiler/core";
import { minuteStartOf, submitClientLatency } from "../../core";
import { insertInteractions, mergeMetricMinute } from "./store";

// A browser's clock can be wrong; a minute from the future or the distant past is
// dropped rather than written where no host record will ever classify it.
const MAX_AGE_MS = 6 * 60 * 60_000;
const MAX_AHEAD_MS = 2 * 60_000;

/**
 * The browser's half of the ledger: its minutes of page-load / navigation /
 * update-delay histograms, merged into the same rows the server writes, plus the
 * raw page loads and navigations. Posted once a minute per tab at most, and on
 * `pagehide`.
 */
export const handleClientLatency = implement(
  submitClientLatency,
  async ({ body }) => {
    const now = Date.now();
    const inRange = (ms: number): boolean =>
      ms >= now - MAX_AGE_MS && ms <= now + MAX_AHEAD_MS;
    // Observability, not something the user is waiting on: run it in the
    // background connection lane even though an HTTP request carries it.
    await runInBackgroundLane(async () => {
      for (const m of body.minutes) {
        if (!inRange(m.minuteStart)) continue;
        await mergeMetricMinute({
          metric: m.metric,
          minuteStart: minuteStartOf(m.minuteStart),
          acc: {
            counts: m.counts,
            count: m.count,
            sumMs: m.sumMs,
            maxMs: m.maxMs,
            censored: m.censored,
            excluded: m.excluded,
          },
        });
      }
      await insertInteractions(
        body.interactions.filter((i) => inRange(i.occurredAt)),
        body.client,
      );
    });
    return { ok: true };
  },
);
