import { z } from "zod";
import { count, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  IdleBlocker,
  requestIdleEvaluation,
} from "@plugins/infra/plugins/host/plugins/idle/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { isAgentBusy } from "@plugins/conversations/core";
import { agentsReading } from "./reading";

/** The statuses an agent counts as working in (`isAgentBusy`), as data. */
const BUSY_STATUSES = ConversationStatusSchema.options.filter(isAgentBusy);

/**
 * Agents starting or working. Read from THIS backend's conversations — on
 * main, every conversation launched from the app (a worktree backend's own
 * launches live in its fork and are not seen here; their builds and tests
 * still are, through the ops blocker).
 */
export const agentsIdleBlocker = IdleBlocker({
  id: "agents",
  read: async () => {
    const [row] = await db
      .select({ n: count() })
      .from(_conversations)
      .where(inArray(_conversations.status, BUSY_STATUSES));
    return agentsReading(row?.n ?? 0);
  },
});

/**
 * A conversation's status moved: ask for a re-evaluation when it crossed the
 * busy line (a `waitingFor` change or working → starting moves nothing).
 */
export const agentsIdleNotifyJob = defineJob({
  name: "conversations.idle-blocker.notify",
  description:
    "Tells the idle signal that an agent started or stopped working, so idle-time work begins only when no agent is working and stops when one starts.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      status: ConversationStatusSchema,
      previousStatus: ConversationStatusSchema,
    })
    .passthrough(),
  run: async ({ event }) => {
    if (event === undefined) return;
    if (isAgentBusy(event.status) === isAgentBusy(event.previousStatus)) return;
    await requestIdleEvaluation();
  },
});
