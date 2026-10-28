import { listActiveWorktreeOps } from "@plugins/infra/plugins/worktree/server";
import {
  decideStop,
  outstandingFor,
  releaseAgent,
  type LiveOp,
} from "../core/stop-guard";

/** The stop hook proper, loaded by `./stop-guard.ts` once the checkout is known installed. */

interface StopInput {
  session_id?: string;
  /** Present for SubagentStop; absent for a plain Stop, which we never block. */
  agent_id?: string;
  /** TeammateIdle names the teammate instead; either identifies "who is stopping". */
  teammate_name?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
}

/** What the hook prints for payload `raw`: a block decision, or "" to allow. */
export async function stopHook(raw: string): Promise<string> {
  let input: StopInput = {};
  if (raw.trim()) {
    try {
      input = JSON.parse(raw) as StopInput;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return ""; // malformed payload — never block on it
    }
  }

  // Who is stopping. `agent_id` for a subagent, the teammate's name for a
  // teammate going idle: one identity either way, and the same one
  // `background-ops` recorded the op under.
  const agentId = input.agent_id ?? input.teammate_name;
  const sessionId = input.session_id;
  if (!agentId || !sessionId) return ""; // the main conversation: not ours to block

  const started = outstandingFor(sessionId, agentId);
  // The cheap read first: an agent that never started an op — nearly every stop —
  // costs one small file read and no directory scan.
  if (started.length === 0) return "";

  const live: LiveOp[] = (await listActiveWorktreeOps()).map((o) => ({
    slug: o.slug,
    op: o.op,
  }));

  const verdict = decideStop(started, live, input.stop_hook_active === true);
  if (verdict.kind === "allow") {
    // Nothing of this agent's is running any more; drop the record so the next
    // stop short-circuits on the cheap read above.
    releaseAgent(sessionId, agentId);
    return "";
  }

  return JSON.stringify({ decision: "block", reason: verdict.reason });
}
