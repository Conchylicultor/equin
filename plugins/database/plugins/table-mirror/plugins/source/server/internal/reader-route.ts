import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * What serves this source's readers to a replica. The readers are pure
 * functions; the routes a replica reaches them by belong to whoever knows the
 * transport (the deploy app's `site-mirror/box`: host-only routes curled over
 * SSH). That plugin imports this one, so this one cannot import it back: the
 * need is declared as a COMPANION kind. The route owner contributes
 * `MirrorReaderRoutes({ companion: true, reason })`, the closure engine ships
 * it wherever this source ships, and a serving host booting a mirror set
 * without one fails (`assertMirrorReadable`).
 */
export const MirrorReaderRoutes = defineServerContribution<{
  /** Which routes serve the readers, and to whom. */
  reason: string;
}>("table-mirror-reader-routes", {
  companions: true,
  docLabel: (p) => p.reason,
});

/**
 * A serving host that mirrors a set must serve its readers, or no replica can
 * ever read it. The composition graph guarantees it (`MirrorReaderRoutes` is a
 * companion kind), so this fires only on a graph assembled outside the
 * closure engine.
 */
export function assertMirrorReadable(
  sets: readonly { id: string }[],
  routes: readonly { reason: string }[],
): void {
  if (sets.length === 0 || routes.length > 0) return;
  throw new Error(
    `[table-mirror] this serving host mirrors ${sets.map((s) => `"${s.id}"`).join(", ")} but boots no MirrorReaderRoutes contribution, so no replica can read it. ` +
      "The route owner contributes `MirrorReaderRoutes({ companion: true, reason })`, so the closure engine ships it wherever table-mirror/source ships — a graph without it was not resolved from a composition.",
  );
}
