import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * What bounds `live_state_changelog`. The feed's trigger function appends a
 * row on every commit and nothing in change-feed ever deletes one: the rows are
 * kept for whoever replays them, so whoever replays them owns the horizon below
 * which none is needed. Such a plugin reads the feed (it imports change-feed),
 * so change-feed cannot import it back: the need is declared as a COMPANION
 * kind instead. The pruner contributes `ChangelogRetention({ companion: true,
 * reason })`, the closure engine ships it wherever change-feed ships, and a
 * serving host booting the feed without one fails (`assertChangelogRetained`).
 */
export const ChangelogRetention = defineServerContribution<{
  /** What prunes the changelog, and below which horizon. */
  reason: string;
}>("change-feed-changelog-retention", {
  companions: true,
  docLabel: (p) => p.reason,
});

/**
 * A serving host (one that runs `onReady`: the desktop's `serve`, a browser
 * host) must boot something that prunes the changelog, or every write grows it
 * forever. Only a serving host is held to it — an `exec` child and a
 * partial-graph test boot never reach `onReady` — and the composition graph
 * guarantees it there (`ChangelogRetention` is a companion kind), so this
 * fires only on a graph assembled outside the closure engine.
 */
export function assertChangelogRetained(
  retention: readonly { reason: string }[],
): void {
  if (retention.length > 0) return;
  throw new Error(
    "[change-feed] this serving host boots no ChangelogRetention contribution, so nothing prunes " +
      "`live_state_changelog`: every commit appends a row and the table grows without bound. " +
      "Its pruner contributes `ChangelogRetention({ companion: true, reason })`, so the closure engine " +
      "ships it wherever change-feed ships — a graph without it was not resolved from a composition.",
  );
}
