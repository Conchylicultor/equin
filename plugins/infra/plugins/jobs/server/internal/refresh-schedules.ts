import { JobQueue } from "./queue";

/**
 * Re-read every resolver-form schedule now and install the result, so a
 * schedule a setting decides changes without a restart. Before the queue's
 * `onAllReady` install it does nothing: that install reads the same
 * resolvers.
 */
export function refreshJobSchedules(): void {
  JobQueue.get().refreshSchedules();
}
