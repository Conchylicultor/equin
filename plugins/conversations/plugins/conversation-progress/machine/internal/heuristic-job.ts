import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { followConversation } from "./progress-watch";

// Triggered on every conversationTurnCompleted. A turn is only the moment a
// conversation is known to be running: the phase itself is derived from its
// worktree's changes as they happen (progress-watch), so after the first turn
// this is a map lookup — no git read, no tree walk.
export const classifyProgressJob = defineJob({
  name: "conversation-progress.classify",
  description:
    "Starts following a conversation's worktree changes to tell whether it is researching, designing or implementing.",
  // seconds: the first run for a conversation opens a checkout watch and
  // classifies the whole worktree once (merge-base / diff / ls-files, each
  // bounded by commit-list's git timeout); every later run returns at once.
  hold: "seconds",
  input: z.object({}).passthrough(),
  event: z.object({ conversationId: z.string() }).passthrough(),
  dedup: "none",
  maxAttempts: 2,
  run: async ({ event }) => {
    const conversationId = event?.conversationId;
    if (!conversationId) return;
    await followConversation(conversationId);
  },
});
