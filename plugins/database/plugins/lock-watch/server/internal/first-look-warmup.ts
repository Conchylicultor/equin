import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { lockWatchJob } from "./watch-job";

// The first look right after boot, instead of at the next minute boundary.
//
// The latest look lives in this backend's memory (`state.ts`), so every
// restart starts with none — and the health report's Database row says "the
// lock watch has not looked yet" (`unknown`, never green) until the cron's
// next tick, up to a minute later. One enqueue at boot closes that gap: the
// singleton's manual enqueue shares the cron's pending row and, in graphile's
// default `replace` mode, makes it due now; the cron re-queues the next tick
// as usual. `worktree` scope — every backend watches its own database.
export const lockWatchFirstLookWarmup = defineWarmup({
  name: "database.lock-watch.first-look",
  description:
    "Takes the lock watch's first look right after boot, so the health report's Database row does not wait up to a minute for the next scheduled one.",
  scope: "worktree",
  run: async () => {
    await lockWatchJob.enqueue({});
  },
});
