import type { HealthStatus } from "@plugins/shell/plugins/health-report/core";
import type { StoreUsage } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { formatBytes } from "./format";

/** A `refuse` owner this full is one burst of typing from losing a draft. */
const NEAR_CAP = 0.8;

/**
 * The Browser storage row's verdict, from the in-memory counters only (no
 * scan, so it is free on every render):
 * - critical — the browser refused a write this page load (area full or blocked);
 * - attention — an owner refused a write at its own cap, or a `refuse` owner is
 *   past 80% of its cap;
 * - ok — otherwise, with the footprint of the owners this page has touched.
 */
export function storageVerdict(usage: StoreUsage[]): HealthStatus {
  const browser = usage.filter((u) => u.refusedByBrowser > 0);
  if (browser.length > 0)
    return {
      state: "critical",
      summary: `Browser refused writes: ${browser.map((u) => u.label).join(", ")}`,
    };
  const overCap = usage.filter((u) => u.refusedOverCap > 0);
  if (overCap.length > 0)
    return {
      state: "attention",
      summary: `Over their cap: ${overCap.map((u) => u.label).join(", ")}`,
    };
  const near = usage.filter(
    (u) =>
      u.whenFull === "refuse" && u.bytes !== null && u.bytes > u.cap * NEAR_CAP,
  );
  if (near.length > 0)
    return {
      state: "attention",
      summary: `Nearly full: ${near.map((u) => u.label).join(", ")}`,
    };
  const touched = usage.filter((u) => u.bytes !== null);
  const bytes = touched.reduce((sum, u) => sum + (u.bytes ?? 0), 0);
  return {
    state: "ok",
    summary: `${formatBytes(bytes)} across ${touched.length} of ${usage.length} owners`,
  };
}
