import { useEffect } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useConfig } from "@plugins/config_v2/web";
import { slowResourceReportSink } from "@plugins/primitives/plugins/live-state/web";
import { getBootTrace } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { clientLatencySink } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import { toClientBootSection } from "@plugins/debug/plugins/trace/plugins/client-boot/core";
import { slowOpConfig } from "../../core";
import { TRANSPORT_LAYER } from "../../shared/endpoints";
import { latencySlowOp } from "../internal/latency-slow-op";
import { enqueueSlowOp } from "../internal/slow-op-queue";

// A Core.Root side-effect component. It owns the client-side slow-op signals —
// page-load timing, live-state element settle, and every client latency signal
// (perfs/latency-signal: live update, write confirm, …) — and funnels them into
// the slow-op queue, which debounces and batches them onto the slow-ops client
// endpoint. Renders nothing.
export function SlowOpCollector() {
  const cfg = useConfig(slowOpConfig);

  // Keep the latest thresholds in a ref so the reporter closures (registered
  // once on mount) always read live values without re-registering on each
  // config change.
  const cfgRef = useLatestRef(cfg);

  // Page-load signal: measure first-content paint in a post-paint frame.
  useEffect(() => {
    // A hidden tab gets NO animation frame until it is shown again, so this
    // callback would fire minutes later and report the time the tab sat in the
    // background as a page load (a 1,569 s "load" was recorded that way on
    // 2026-09-19). Once the tab has been hidden the number means nothing: drop it.
    let wasHidden = document.visibilityState === "hidden";
    const onVisibility = () => {
      if (document.visibilityState === "hidden") wasHidden = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    const id = requestAnimationFrame(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (wasHidden) return;
      const ms = performance.now();
      const t = cfgRef.current.pageLoadMs;
      if (ms <= t) return;
      const durationMs = Math.round(ms);
      enqueueSlowOp({
        // No `caller`: page-load's `operation` IS the route path, so a
        // route caller would just duplicate the operation label.
        operationKind: "page-load",
        operation: currentRoutePath(),
        durationMs,
        thresholdMs: t,
        // The browser's own boot decomposition rides along (trimmed to stay far
        // under the 64KB keepalive cap), so the resulting trace carries the
        // client evidence for WHY the load was slow — not just that it was.
        clientBoot: toClientBootSection(getBootTrace()),
      });
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Element signal: live-state resources hand us their mount → settle duration.
  useEffect(() => {
    slowResourceReportSink.register((info) => {
      // Mount→first-data settle IS the user-perceived time-to-content. Report it
      // as-is, including the cold-start boot wave: a slow boot is a real UX
      // regression, not noise. The gateway hot-swaps only once the backend is
      // ready (warm pool, migrations applied) — so a slow settle right after a
      // swap means readiness flipped before the backend could serve fast. Fix
      // that at the source; never suppress this signal. Batching below is a
      // transport change only — every signal still reaches the recorder.
      const t = cfgRef.current.elementMs;
      if (info.durationMs <= t) return;
      const durationMs = Math.round(info.durationMs);
      enqueueSlowOp({
        operationKind: "element",
        operation: `${info.key} ${JSON.stringify(info.params)}`,
        durationMs,
        thresholdMs: t,
        // The route under which the element settled is the cheap, reliable
        // "who mounted this resource" attribution (resource key + params are
        // already in `operation`).
        caller: { kind: "route", label: currentRoutePath() },
        // Additive root-cause attribution: was the notifications transport
        // still coming up when this resource mounted, and how much of the
        // settle window was transport bring-up? The wait is charged to its own
        // layer so the report says WHY it was slow (transport cold-start vs
        // resource compute).
        transportColdStart: info.transportColdStart,
        ...(info.transportWaitMs > 0
          ? { waits: { [TRANSPORT_LAYER]: info.transportWaitMs } }
          : {}),
      });
    });
    return () => slowResourceReportSink.register(null);
  }, []);

  // Client latency signals: one generic subscriber for the whole vocabulary.
  // It never names a signal — the threshold, layers and variant all come from
  // the sample and CLIENT_SIGNAL_THRESHOLD (see latencySlowOp).
  useEffect(
    () =>
      clientLatencySink.subscribe((sample) => {
        const item = latencySlowOp(sample, cfgRef.current, currentRoutePath());
        if (item) enqueueSlowOp(item);
      }),
    [],
  );

  return null;
}
