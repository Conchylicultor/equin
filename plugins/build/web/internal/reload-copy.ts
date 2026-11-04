import type { ReloadAdvice, ServerBehind } from "../hooks/use-reload-advice";

export type ShownAdvice = Exclude<ReloadAdvice, { kind: "none" }>;

/**
 * What the Reload pill says about why — its tooltip and accessible name, the
 * same in the Build tray and alone in the collapsed bar's glance.
 */
export function reloadMessageFor(advice: ShownAdvice): string {
  if (advice.kind === "stale") {
    return "Server was rebuilt — click to reload this tab";
  }
  if (advice.kind === "outdated") {
    return "This tab is out of date and can't load some data — reload to fix";
  }
  return advice.stale
    ? "This tab is out of date and part of the app didn't load — reload to fix"
    : "Part of the app didn't load — reload to fix";
}

/** Something already fails (outdated reads, a plugin that did not load) — red, not blue. */
export function reloadIsFailing(advice: ShownAdvice): boolean {
  return advice.kind === "broken" || advice.kind === "outdated";
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
