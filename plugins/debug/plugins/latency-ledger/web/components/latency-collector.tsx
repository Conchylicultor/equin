import { useEffect } from "react";
import { clientLatencySink } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { pausesDuring } from "@plugins/primitives/plugins/perfs/plugins/page-pauses/web";
import { recordInteraction, recordSample } from "../internal/client-ledger";
import { startInteractionTracking } from "../internal/interaction-tracker";

// A Core.Root side-effect component: mounted once per tab, renders nothing. It
// feeds the browser's three measurements into the client ledger — every page
// load, every in-app navigation, and the delay of every update a server change
// pushes into this tab.
export function LatencyCollector() {
  useEffect(() => startInteractionTracking(recordInteraction), []);

  // The update delay is the `update` latency signal's total (change → pushed
  // frame applied). Other signals have no ledger metric yet; a sample the tab
  // spent hidden in (page-pauses, asked over the sample's span — it is emitted
  // at its end) is kept but excluded from the percentiles.
  useEffect(
    () =>
      clientLatencySink.subscribe((sample) => {
        if (sample.signal !== "update") return;
        const end = Date.now();
        const { hiddenMs } = pausesDuring(end - sample.totalMs, end);
        recordSample("update-e2e", sample.totalMs, { excluded: hiddenMs > 0 });
      }),
    [],
  );

  return null;
}
