import { implement } from "@plugins/infra/plugins/endpoints/server";
import { agentWrites, revertAgentWrites } from "../../core";
import { listAgentWrites, revertAgentWritesIn } from "./ledger";

/**
 * What every agent-write ledger currently holds.
 *
 * The e2e harness polls this between closing the browser and reverting: a
 * DataView's write-back is a 400ms trailing debounce, so a POST can still be in
 * flight when the page dies, and `lastWriteAt` going unchanged across a window
 * wider than the debounce is the signal that the writes have stopped arriving.
 */
export const handleAgentWrites = implement(agentWrites, () =>
  listAgentWrites(),
);

/**
 * Restore what the named session(s) wrote, in every ledger.
 *
 * Returns 200 with a three-armed outcome rather than throwing on partial
 * failure: `failed` is per entry, and the caller (the harness) is the one place
 * that decides a failed revert fails the run. Throwing here would lose the
 * entries that DID revert.
 */
export const handleRevertAgentWrites = implement(
  revertAgentWrites,
  ({ body }) => revertAgentWritesIn(body),
);
