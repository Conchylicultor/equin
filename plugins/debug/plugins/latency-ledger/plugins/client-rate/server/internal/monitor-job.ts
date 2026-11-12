import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import {
  readClientHours,
  readClientRoutes,
} from "@plugins/debug/plugins/latency-ledger/server";
import { clientRateConfig } from "../../core";
import {
  baselineOf,
  currentHour,
  historyRange,
  judgeClientHours,
  type Kind,
  type KindBaseline,
} from "./client-rate-baseline";

// Durable: what was NOT judged (a kind in warm-up, trips past the cap) must be
// readable afterwards, not only from memory.
const log = defineLogSink({
  id: "client-rate",
  description:
    "client-rate monitor: kinds not judged yet (warm-up: too little per-client history) and trips past the per-tick report cap.",
});

// Trips filed per tick at most, furthest past their bar first; the rest are
// logged, never silently dropped.
const TOP_N = 5;
const TOP_ROUTES = 5;

// The history is the 7 whole days before today: it changes when the day does,
// and when a late post (a tab's rows kept while the server was down, up to 6 h
// old) lands in it. Read once per clock hour, not every tick.
let history: { hour: number; baseline: Record<Kind, KindBaseline> } | undefined;

async function baselineFor(nowMs: number): Promise<Record<Kind, KindBaseline>> {
  const hour = currentHour(nowMs).from.getTime();
  if (history?.hour !== hour) {
    const range = historyRange(nowMs);
    history = {
      hour,
      baseline: baselineOf(await readClientHours(range.from, range.to)),
    };
  }
  return history.baseline;
}

// Every 5 min in each backend (the ledger is per-worktree): count each browser
// tab's page loads and navigations of each route in the clock hour so far, and
// judge them against how many times a client usually loads one route in an hour. A tab reloading in a
// loop is spread thin across ops (op-rate cannot see it); counted per tab it
// stands out. Automated tabs (the agent browser, e2e runs) are judged the same
// and marked in the report.
export const clientRateMonitorJob = defineJob({
  name: "debug.client-rate-monitor",
  description:
    "Files a report when one browser tab loads (or navigates to) the same route far more often in an hour than a client usually does.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/5 * * * *", perWorktree: true },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(clientRateConfig);
    if (!cfg.enabled) return;
    const now = Date.now();
    const baseline = await baselineFor(now);
    for (const [kind, b] of Object.entries(baseline))
      if (b.kind === "warm-up")
        log.publish(
          `${kind} not judged: ${b.clientHours} client-route-hours of history (warm-up)`,
        );

    const hour = currentHour(now);
    const trips = judgeClientHours(
      await readClientHours(hour.from, hour.to),
      baseline,
      cfg.baselineFactor,
    );
    if (trips.length > TOP_N)
      log.publish(
        `${trips.length - TOP_N} over-threshold clients not reported (top-${TOP_N} cap)`,
      );

    for (const t of trips.slice(0, TOP_N)) {
      const topRoutes = await readClientRoutes(
        t.clientId,
        t.interaction,
        hour.from,
        hour.to,
        TOP_ROUTES,
      );
      await recordReport({
        kind: "client-rate",
        source: "server-client-rate-monitor",
        data: {
          interaction: t.interaction,
          clientId: t.clientId,
          route: t.route,
          automated: t.automated,
          count: t.count,
          hourStart: hour.from.toISOString(),
          usual: t.usual,
          threshold: t.threshold,
          historyClientHours: t.historyClientHours,
          topRoutes,
        },
        message:
          `${t.route} — ${t.count} ${t.interaction}s this hour from one ${t.automated ? "automated " : ""}tab, ` +
          `usually ≤${t.usual} of one route per client-hour (threshold ${t.threshold})`,
      });
    }
  },
});
