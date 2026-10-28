import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { isAgentBusy } from "@plugins/conversations/core";

// The launch cap's pure policy, DB-free so it is tested alone; the locked,
// DB-reading half is `launch-cap.ts`.

/** Free launch slots: never negative (user launches may push busy past max). */
export function freeLaunchSlots(busy: number, maxConcurrent: number): number {
  return Math.max(0, maxConcurrent - busy);
}

/** Whether a status change released a launch slot (busy → not busy). */
export function releasedLaunchSlot(
  previous: ConversationStatus,
  next: ConversationStatus,
): boolean {
  return isAgentBusy(previous) && !isAgentBusy(next);
}

/**
 * The first `slots` ids, in order, that `isLaunchable` accepts — checked one at
 * a time, stopping as soon as enough are found. Ordered candidates (oldest
 * armed first) keep the queue FIFO; skipping the unlaunchable ones (blocked,
 * held) keeps a blocked old task from taking a freed slot nothing can use.
 */
export async function takeLaunchable(
  idsInOrder: readonly string[],
  slots: number,
  isLaunchable: (id: string) => Promise<boolean>,
): Promise<string[]> {
  const picked: string[] = [];
  for (const id of idsInOrder) {
    if (picked.length >= slots) break;
    if (await isLaunchable(id)) picked.push(id);
  }
  return picked;
}
