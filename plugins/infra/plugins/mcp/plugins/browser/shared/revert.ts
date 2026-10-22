import {
  endpointRequest,
  readEndpointResponse,
} from "@plugins/infra/plugins/endpoints/core";
import { agentOriginHeaders } from "@plugins/infra/plugins/request-origin/core";
import { revertAgentWrites } from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/core";
import { browserSessionSource } from "./protocol";

const REVERT_MS = 30_000;

/**
 * Revert the durable writes ONE conversation's browser session made on one
 * deploy — its own request-origin source only, so another conversation's
 * session or an e2e run on the same deploy keeps theirs.
 *
 * The host calls it when it closes a session. A backend calls it itself for
 * the sessions a host that DIED still listed (SIGKILL, OOM): their writes sit
 * in each target's on-disk ledger, and nothing else will ever revert them.
 */
export async function revertSessionWrites(
  /** A deploy the session stamped: `http://<namespace>.localhost:9000`. */
  origin: string,
  conversationId: string,
): Promise<void> {
  const source = browserSessionSource(conversationId);
  // Built and read through the endpoint's contract; sent with a raw fetch
  // because this module also runs in the agent-browser host, which cannot
  // import `endpoints/server`'s callEndpoint (see exempt/).
  const { path, init } = endpointRequest(
    revertAgentWrites,
    {},
    {
      headers: agentOriginHeaders(source),
      body: { scope: "source", source },
      signal: AbortSignal.timeout(REVERT_MS),
    },
  );
  const res = await fetch(`${origin}${path}`, init);
  await readEndpointResponse(
    revertAgentWrites,
    res,
    (status, rawBody) =>
      `[agent-browser] reverting ${source}'s writes on ${origin} failed: HTTP ${status} ${rawBody ?? ""}`,
  );
}

/**
 * Revert a session's writes on every deploy it stamped — its own build, main,
 * another worktree it was pointed at. Each is tried even when one fails (a
 * deploy torn down since cannot answer), and the failures throw together.
 */
export async function revertSessionWritesOn(
  origins: readonly string[],
  conversationId: string,
): Promise<void> {
  const failures: string[] = [];
  for (const origin of origins) {
    try {
      await revertSessionWrites(origin, conversationId);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      failures.push(err.message);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}
