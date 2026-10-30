import { useEffect } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useConfig } from "@plugins/config_v2/web";
import { slowResourceReportSink } from "@plugins/primitives/plugins/live-state/web";
import { getBootTrace } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { clientLatencySink } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import { toClientBootSection } from "@plugins/debug/plugins/trace/plugins/client-boot/core";
import { clientSlowOpSink, slowOpConfig } from "../../core";
import { elementSlowOp, transportSlowOp } from "../internal/element-slow-op";
import { latencySlowOp } from "../internal/latency-slow-op";
import { endingNow } from "../internal/page-pause-judge";
import { enqueueSlowOp } from "../internal/slow-op-queue";

// The page's transport bring-up is filed at most once (see transportSlowOp).
let transportBringUpFiled = false;

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
        // No window: a long frame during the load IS the load (bundle eval,
        // first render), so nothing is taken off it.
        ownMs: durationMs,
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
      // Mount→first-data settle is the user-perceived time-to-content, judged
      // on the resource's OWN part of it: the transport bring-up it waited out
      // is the transport's, filed once against it below (a slow boot stays
      // loud — on the op that owns it). See "Own time" in ../../CLAUDE.md.
      const route = currentRoutePath();
      const item = elementSlowOp(info, cfgRef.current, route);
      if (item) enqueueSlowOp(item, endingNow(info.durationMs));
      if (
        !transportBringUpFiled &&
        info.transportColdStart &&
        info.transportReadyAtMs !== null
      ) {
        transportBringUpFiled = true;
        const transport = transportSlowOp(
          info.transportReadyAtMs,
          cfgRef.current,
          route,
        );
        // Page start → socket open, on the wall clock: a page loaded hidden is
        // dropped at the flush like any other span.
        if (transport)
          enqueueSlowOp(transport, {
            startMs: performance.timeOrigin,
            endMs: performance.timeOrigin + info.transportReadyAtMs,
          });
      }
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
        // Emitted at its end: the window is the last `totalMs` of wall time.
        if (item) enqueueSlowOp(item, endingNow(sample.totalMs));
      }),
    [],
  );

  // Fully-formed slow-ops from producers outside slow-ops (clientSlowOpSink):
  // each judged itself against its own bar, so it is forwarded unchanged —
  // all of it its own time (a main-thread stall IS the frozen page).
  useEffect(
    () =>
      clientSlowOpSink.subscribe((signal) =>
        enqueueSlowOp({ ...signal, ownMs: signal.durationMs }),
      ),
    [],
  );

  return null;
}
