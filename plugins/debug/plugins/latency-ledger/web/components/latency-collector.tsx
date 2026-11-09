import { useEffect } from "react";
import {
  clientLatencySink,
  type ClientLatencySignal,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import type { ClientLatencyMetric } from "../../core";
import { pausesDuring } from "@plugins/primitives/plugins/perfs/plugins/page-pauses/web";
import { recordInteraction, recordSample } from "../internal/client-ledger";
import { startInteractionTracking } from "../internal/interaction-tracker";

// The ledger metric each client latency signal's total is kept as; a signal
// with none (a write's confirm) is left to Debug → Slow Events.
const METRIC_OF: Partial<Record<ClientLatencySignal, ClientLatencyMetric>> = {
  update: "update-e2e",
  "turn-echo": "turn-echo",
};

// A Core.Root side-effect component: mounted once per tab, renders nothing. It
// feeds the browser's measurements into the client ledger — every page
// load, every in-app navigation, the delay of every update a server change
// pushes into this tab, and of every sent message reaching it.
export function LatencyCollector() {
  useEffect(() => startInteractionTracking(recordInteraction), []);

  // A signal's total, as its metric (`METRIC_OF`): the update delay (change →
  // pushed frame applied), a sent message shown. A sample the tab spent hidden
  // in (page-pauses, asked over the sample's span — it is emitted at its end)
  // is kept but excluded from the percentiles.
  useEffect(
    () =>
      clientLatencySink.subscribe((sample) => {
        const metric = METRIC_OF[sample.signal];
        if (metric === undefined) return;
        const end = sample.endedAt ?? Date.now();
        const { hiddenMs } = pausesDuring(end - sample.totalMs, end);
        recordSample(metric, sample.totalMs, { excluded: hiddenMs > 0 });
      }),
    [],
  );

  return null;
}
