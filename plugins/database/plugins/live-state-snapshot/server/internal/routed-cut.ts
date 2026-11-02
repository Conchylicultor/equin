import type { RoutedCut } from "@plugins/framework/plugins/server-core/core";

/**
 * The runtime's `routedCut` (what lets a persisted alias's floor persist
 * ADVANCE its row's position): change-feed's `feedCut`, which proves every
 * change below its `cutXid` that the LISTEN session delivered was routed —
 * but a session hears only what commits after it is up. A change committed
 * before that reaches the runtime only through this plugin's boot catch-up
 * replay, so the cut is refused (`unproven`) until `caughtUp()` says the
 * replay has routed every changelog row since each key's floor, read after
 * the LISTEN session was established. A boot whose replay could not be shown
 * to follow the LISTEN (no session in time, a catch-up that threw) never
 * calls it: nothing is advanced in that process.
 *
 * A later session loss is covered by change-feed itself: the reconnect's
 * sweep routes a FULL to every reader, so the tuple is not settled until a
 * whole read rebuilt it, and `feedCut` refuses while no session is up.
 */
export function createRoutedCut(feedCut: () => Promise<{ cutXid: string }>): {
  cut: () => Promise<RoutedCut>;
  caughtUp: () => void;
} {
  let caughtUp = false;
  return {
    async cut() {
      if (!caughtUp) {
        return {
          kind: "unproven",
          reason: "the boot catch-up has not routed the changelog yet",
        };
      }
      // A refused cut (no session, a lost one, past its deadline) throws by
      // contract: it is a cut that could not be proven, never a failure to
      // hide — the floor persist falls back to lowering the floor.
      try {
        const { cutXid } = await feedCut();
        return { kind: "cut", cutXid };
      } catch (err) {
        return { kind: "unproven", reason: String(err) };
      }
    },
    caughtUp() {
      caughtUp = true;
    },
  };
}
