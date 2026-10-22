import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import {
  attemptHasOpenConversation,
  attemptOfConversation,
} from "../../server/internal/rows";
import { stopCheckoutAgents } from "./agent-processes";

/**
 * Stop the agents an attempt's worktree launched once its last conversation is
 * closed. An agent testing its own build starts conversations in the worktree's
 * backend (its forked DB); nothing in main knows them, and once that backend
 * stops nothing reaps them — they sat `waiting` for hours, each holding a
 * Claude Code process. Closing the work is what ends them.
 *
 * Main only: main owns the canonical conversation rows, and a worktree's fork
 * closing a copied row must not reach another worktree's agents. A worktree
 * workspace's checkout is named by its attempt id (`<root>/<attemptId>`); any
 * other kind (scratch) has no backend, so no namespace matches it.
 */
export const attemptEndedJob = defineJob({
  name: "runtime-sdk.attempt-ended",
  description:
    "When an attempt's last conversation is closed, stops the SDK agents its worktree's backend launched (conversations it started while testing its own build).",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ conversationId: z.string(), status: ConversationStatusSchema })
    .passthrough(),
  run: async ({ event }) => {
    if (!event || event.status !== "done" || !isMain()) return;
    const attemptId = await attemptOfConversation(event.conversationId);
    if (await attemptHasOpenConversation(attemptId)) return;
    stopCheckoutAgents(attemptId);
  },
});
