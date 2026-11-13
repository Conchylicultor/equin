import { useEffect } from "react";
import { ReportSinks } from "../slots";

/**
 * Attaches every `ReportSinks.Collector` it can see while mounted. Mounted at
 * the page root and inside every `PluginScope` (`scope: "each"`), so a
 * collector the page holds only on demand (the website's live demo) drains
 * its sink once the scope loads it. Attaching is counted per sink (`drain`),
 * so the page's and a scope's host sharing a collector register it once.
 */
export function SinkCollectors() {
  const collectors = ReportSinks.Collector.useContributions();
  useEffect(() => {
    const detaches = collectors.map((c) => c.collect.attach());
    return () => {
      for (const detach of detaches) detach();
    };
  }, [collectors]);
  return null;
}
