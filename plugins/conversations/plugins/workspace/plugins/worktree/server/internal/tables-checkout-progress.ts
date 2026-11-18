import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

/**
 * What `worktree.checkoutProgress` carries: WHICH attempt's checkout moved,
 * and nothing else — like `supervisedRun.ended`, a wake-up, never the answer.
 * The checkout on disk (`checkoutState`) and the run row stay the authority;
 * a waiter re-reads both.
 */
export interface CheckoutProgressPayload {
  attemptId: string;
  [key: string]: unknown;
}

/**
 * "The checkout of attempt A moved": emitted by the `worktree.prepare` child
 * once the checkout's files are written (before its install), and by the
 * job's `onEnded` once its run ended, whatever the outcome — so a spawn
 * waiting to start its agent in the files is woken by either, the run that
 * failed before writing them included.
 */
export const {
  event: checkoutProgress,
  table: _worktreeCheckoutProgressTriggers,
} = defineTriggerEvent<CheckoutProgressPayload>({
  name: "worktree.checkoutProgress",
  filters: {
    attemptId: text("attempt_id"),
  },
});
