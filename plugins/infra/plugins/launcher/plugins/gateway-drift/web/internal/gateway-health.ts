import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { GatewayDrift } from "../../core";

/**
 * The Gateway row's verdict.
 *
 * - still loading → `unknown`, no summary ("Checking…"), never `ok`;
 * - `current` → `ok`;
 * - `stale` → `attention`, one line: nothing reaches the running gateway by
 *   itself, and after a reboot the service manager keeps starting the old one.
 *   What differs is the row's Update popover (`UpdateGatewayButton`), which
 *   hands it to an agent;
 * - `unreadable` → `unknown` with why;
 * - `not-applicable`, or `unavailable` (a host without the computer) →
 *   `not-applicable` with the sentence saying so.
 */
export function gatewayVerdict(
  result: ResourceResult<GatewayDrift> | ResourceUnavailable,
): HealthStatus {
  if (result.status === "unavailable") {
    return { state: "not-applicable", summary: result.message };
  }
  if (result.status === "loading") return { state: "unknown" };
  if (result.status === "error") {
    return { state: "unknown", summary: "Couldn't load the gateway's status" };
  }
  const d = result.data;
  switch (d.kind) {
    case "current":
      return {
        state: "ok",
        summary: "Up to date",
      };
    case "stale":
      return {
        state: "attention",
        summary: "Out of date",
      };
    case "not-applicable":
      return { state: "not-applicable", summary: d.reason };
    case "unreadable":
      return {
        state: "unknown",
        summary: `Couldn't compare the gateway: ${d.message}`,
      };
  }
}
