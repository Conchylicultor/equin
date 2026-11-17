import type { ServerBehind } from "../hooks/use-tab-update";
import type { UpdateAffordance } from "./update-policy";

/**
 * What the Update pill says — its label, and its tooltip and accessible name
 * (the same in the Build tray and alone in the collapsed bar's glance).
 */
export function updateLabelFor(affordance: ShownAffordance): string {
  return affordance.kind === "fault" ? "Reload" : "Update";
}

export type ShownAffordance = Exclude<UpdateAffordance, { kind: "none" }>;

export function updateMessageFor(
  affordance: ShownAffordance,
  developer: boolean,
): string {
  switch (affordance.kind) {
    case "waiting":
      return `A new version is ready. Update waits for: ${affordance.waitsFor.join(", ")} — click to update now`;
    case "ready":
      return "A new version is ready — click to update";
    case "fault": {
      if (!developer) return "Part of the app didn't load — click to retry";
      const n = affordance.failedPaths.length;
      return `${n === 1 ? "A plugin" : `${n} plugins`} failed to load on the build this tab runs, so no update explains it (reported): ${affordance.failedPaths.join(", ")} — click to retry`;
    }
  }
}

/**
 * Why the Build tray says "Server out of date": the backend still runs an
 * older build than the bundle it serves, so it refuses some of this tab's
 * reads — and a reload would fetch the same bundle into the same refusals.
 */
export function serverBehindMessage(
  behind: Extract<ServerBehind, { behind: true }>,
): string {
  const what =
    behind.count === 1 ? "one kind of data" : `${behind.count} kinds of data`;
  return `The server is still running an older build than this page, so ${what} can't load — a reload won't help; it needs a successful build`;
}
