import { inArray } from "drizzle-orm";
import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { SETTLED_TURN_STATES } from "../../core/schemas";
import { _conversationTurns } from "./tables";

// A turn is worth keeping while it is still on its way, plus a week to debug
// how it ended. Only rows nothing will move again are swept: a held, typing,
// typed, failed or unverified row stays until it settles or its conversation
// is deleted (the FK cascade). Per worktree: the table lives in each fork.
export const conversationTurnsRetention = defineRetention({
  table: _conversationTurns,
  column: "updatedAt",
  ttlDays: 7,
  perWorktree: true,
  where: inArray(_conversationTurns.state, [...SETTLED_TURN_STATES]),
});
