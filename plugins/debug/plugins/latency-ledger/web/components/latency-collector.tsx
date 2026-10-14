import { useEffect } from "react";
import { clientLatencySink } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { recordInteraction, recordSample } from "../internal/client-ledger";
import { startInteractionTracking } from "../internal/interaction-tracker";

// A Core.Root side-effect component: mounted once per tab, renders nothing. It
// feeds the browser's three measurements into the client ledger — every page
// load, every in-app navigation, and the delay of every update a server change
// pushes into this tab.
export function LatencyCollector() {
  useEffect(() => startInteractionTracking(recordInteraction), []);

  // The update delay is the `update` latency signal's total (change → pushed
  // frame applied). Other signals have no ledger metric yet; a hidden tab's
  // sample is kept but excluded from the percentiles.
  useEffect(
    () =>
      clientLatencySink.subscribe((sample) => {
        if (sample.signal !== "update") return;
        recordSample("update-e2e", sample.totalMs, { excluded: sample.hidden });
      }),
    [],
  );

  return null;
}
