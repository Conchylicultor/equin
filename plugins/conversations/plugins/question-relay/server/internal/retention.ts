import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _pendingQuestions } from "./tables";

// A held question is worth keeping only while it is held, plus a week to debug
// how it ended. Open rows have no `resolved_at` and are never swept: a hold
// whose relay died is retired to `abandoned` by the status reconciler (relay
// pid check), which stamps it. Per worktree: the table lives in each fork.
export const pendingQuestionsRetention = defineRetention({
  table: _pendingQuestions,
  column: "resolvedAt",
  ttlDays: 7,
  perWorktree: true,
});
