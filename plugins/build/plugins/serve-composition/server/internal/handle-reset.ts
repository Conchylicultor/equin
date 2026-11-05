import { implement } from "@plugins/infra/plugins/endpoints/server";
import { resetCompositionData } from "../../shared/endpoints";

// Reset is a rare, latency-tolerant action that reaches `database/admin` (drop
// and recreate a database) and the worktree probes, a graph only a reset needs.
// Load `./reset` lazily on first invocation so it never sits on the backend
// boot path — the httpRoute registration stays eager; only the handler body
// defers. The guarded reset throws CompositionResetError when a provenance guard
// rejects the target; that surfaces to the caller as a 500 (a refused reset is a
// genuine error, not a 4xx the UI absorbs) — nothing is touched in that case.
export const handleReset = implement(resetCompositionData, async ({ body }) => {
  const { resetCompositionData: runReset } = await import("./reset");
  await runReset(body.id);
  return { ok: true };
});
