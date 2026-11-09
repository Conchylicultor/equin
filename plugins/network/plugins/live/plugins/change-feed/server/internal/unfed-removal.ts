import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";
import { DatabaseDriver, db } from "@plugins/database/server";
import { changeFeedLog as log } from "./log-sink";
import { rebuildTriggers, type TriggerExclusions } from "./triggers";

// The contract half of the boot install's kept triggers (`rebuildTriggers`'
// `keepUnfed`): the boot left the trigger of every table this code no longer
// feeds in place, for the code that booted before it. Once every such process
// is gone — the previous backend drained after the swap, and any child it
// spawned — the install runs again without keeping, and drops them. A deploy
// abandoned after this backend booted never swaps: the old backend keeps
// serving, this process exits, and the triggers it would have dropped stay.

interface PendingRemoval {
  exclusions: TriggerExclusions;
  layouts: readonly TableLayoutRequirement[];
}

let pending: PendingRemoval | null = null;

/** Set in `onReadyBlocking` when the boot install kept a trigger. */
export function setPendingUnfedRemoval(removal: PendingRemoval | null): void {
  pending = removal;
}

/**
 * Wait until no process that booted before this one is connected, then drop
 * the kept triggers. Nothing to do when the boot kept none. A failure is loud
 * (the caller's rejection is a report) and leaves them for the next boot.
 */
export async function removeUnfedTriggers(): Promise<void> {
  const removal = pending;
  pending = null;
  if (removal === null) return;
  const driver = DatabaseDriver.get();
  await driver.awaitOlderProcessesGone();
  const { kept } = await driver.bootDdl(
    () => rebuildTriggers(db, removal.exclusions, removal.layouts),
    "change-feed: removal of unfed triggers",
  );
  log.publish(
    `[change-feed] older processes gone: dropped the triggers of tables no longer fed (${kept} kept)`,
  );
}
