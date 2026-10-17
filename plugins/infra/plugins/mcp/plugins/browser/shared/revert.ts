import { agentOriginHeaders } from "@plugins/infra/plugins/request-origin/core";
import { revertAgentWrites } from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/core";
import { browserSessionSource } from "./protocol";

const REVERT_MS = 30_000;

/**
 * Revert the durable writes ONE conversation's browser session made on its
 * target — its own request-origin source only, so another conversation's
 * session or an e2e run on the same deploy keeps theirs.
 *
 * The host calls it when it closes a session. A backend calls it itself for
 * the sessions a host that DIED still listed (SIGKILL, OOM): their writes sit
 * in each target's on-disk ledger, and nothing else will ever revert them.
 */
export async function revertSessionWrites(
  /** The session's target: `http://<namespace>.localhost:9000`. */
  origin: string,
  conversationId: string,
): Promise<void> {
  const source = browserSessionSource(conversationId);
  const res = await fetch(`${origin}${revertAgentWrites.path}`, {
    method: revertAgentWrites.method,
    headers: {
      ...agentOriginHeaders(source),
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope: "source", source }),
    signal: AbortSignal.timeout(REVERT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `[agent-browser] reverting ${source}'s writes on ${origin} failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
}
