import { count, inArray, sql } from "drizzle-orm";
import { getConfig } from "@plugins/config_v2/server";
import {
  _conversations,
  type DbExecutor,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  ConversationStatusSchema,
  type ConversationStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { isAgentBusy } from "@plugins/conversations/core";
import { agentLaunchConfig } from "@plugins/conversations/plugins/launch-cap/core";
import { freeLaunchSlots } from "./launch-slots";

// The host-wide launch cap: how many agents may be busy (`starting` or
// `working` — `isAgentBusy`) before the auto-start queue waits for one to
// finish. A launch says which it obeys, explicitly:
//   - "host": the auto-start queue — the machine starts it on its own, so it
//     waits its turn under `agentLaunchConfig.maxConcurrent`.
//   - "none": a launch a human asked for (the UI's Launch) — never capped. It
//     still counts as busy, so it delays the queue's next launch.
export type LaunchCap = "host" | "none";

// Every capped launch serialises on this one transaction-scoped advisory lock,
// so "count busy, then commit one more" cannot interleave across runners: the
// next runner's count sees the previous runner's committed `starting` row.
const HOST_LAUNCH_CAP_LOCK = "conversations.host-launch-cap";

const BUSY_STATUSES: ConversationStatus[] =
  ConversationStatusSchema.options.filter(isAgentBusy);

export async function countBusyConversations(
  exec: DbExecutor,
): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(_conversations)
    .where(inArray(_conversations.status, BUSY_STATUSES));
  // COUNT(*) always answers one row; none is a broken query, not zero.
  if (!row) throw new Error("countBusyConversations: COUNT returned no row");
  return row.n;
}

export async function hostFreeLaunchSlots(exec: DbExecutor): Promise<number> {
  const { maxConcurrent } = getConfig(agentLaunchConfig);
  return freeLaunchSlots(await countBusyConversations(exec), maxConcurrent);
}

/**
 * Inside a launch transaction: take the cap lock (held to the end of `tx`) and
 * answer whether one more busy agent fits. Must run on the SAME transaction
 * that commits the launch, or the lock protects nothing.
 */
export async function takeHostLaunchSlot(tx: DbExecutor): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${HOST_LAUNCH_CAP_LOCK}))`,
  );
  return (await hostFreeLaunchSlots(tx)) > 0;
}
