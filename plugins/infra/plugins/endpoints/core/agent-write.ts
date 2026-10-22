import { z } from "zod";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";

/**
 * Main is read-only for agent sessions: on main's backend, a write carrying the
 * agent-origin headers (`originOf` says `agent` — every request an automated
 * browser session issues) is refused before its handler runs, unless its
 * endpoint declares itself safe for one. Design:
 * `research/2026-10-22-global-main-read-only-for-agent-sessions.md`.
 *
 * Why an endpoint opts OUT rather than in: a new endpoint is protected without
 * anyone remembering to ask. The arms are a closed union, so the reason is
 * stated and grep-able:
 *
 * - `"telemetry"` — writes only observability data (logs, latency samples,
 *   reports): an agent's session produces them like a user's, and refusing them
 *   would hide the agent's own failures.
 * - `"agent-control"` — only ever acts on the agent session's own writes (the
 *   agent-write ledger's revert).
 */
export type AgentWrite = "telemetry" | "agent-control";

/** Methods that cannot write — never gated, and never declare `agentWrite`. */
export const SAFE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

const REFUSED_STATUS = 403;

const refusedBody = z.object({
  reason: z.literal("agent-write-refused"),
  route: z.string(),
  message: z.string(),
});

/** The one sentence a refused agent reads (the failed request, a toast, the console). */
export function agentWriteRefusedMessage(route: string): string {
  return (
    `main is read-only for agent sessions: ${route} was refused before it ran. ` +
    `Reproduce on your own build (./singularity build) and drive that instead.`
  );
}

/**
 * `403 { reason: "agent-write-refused", route, message }`. 403 sits below the
 * crash-report threshold (`reports/endpoint-errors` files 5xx and validation
 * 400s only), and `fetchEndpoint` recognises the body
 * (`isAgentWriteRefusal`) so no other collector files it either.
 */
export function agentWriteRefusedResponse(route: string): Response {
  return Response.json(
    {
      reason: "agent-write-refused",
      route,
      message: agentWriteRefusedMessage(route),
    } satisfies z.infer<typeof refusedBody>,
    { status: REFUSED_STATUS },
  );
}

/** Whether a response's status and parsed body are the agent-write refusal. */
export function isAgentWriteRefusal(status: number, body: unknown): boolean {
  return status === REFUSED_STATUS && refusedBody.safeParse(body).success;
}

/**
 * The gate for one endpoint, decided once at registration: `null` when it can
 * never refuse (a safe method, a declared `agentWrite`, or a backend that is
 * not main's — so a worktree pays nothing per request), else the per-request
 * test answering the refusal for an agent-origin request.
 *
 * The server reads the declaration, never the advisory
 * `AGENT_WRITE_HEADER` a client stamps — that header only tells the agent
 * browser's write drain which requests it need not wait for.
 */
export function agentWriteGate(endpoint: {
  route: string;
  method: string;
  agentWrite?: AgentWrite;
}): ((req: Request) => Response | null) | null {
  if (SAFE_METHODS.has(endpoint.method)) {
    if (endpoint.agentWrite !== undefined) {
      // Fail loudly at boot: a read cannot write, so the declaration is a
      // misunderstanding the reader of the contract would be misled by.
      throw new Error(
        `implement(${endpoint.route}): agentWrite is only meaningful on a write (non-GET) endpoint`,
      );
    }
    return null;
  }
  if (endpoint.agentWrite !== undefined || !isMain()) return null;
  const { route } = endpoint;
  return (req) =>
    originOf(req).kind === "agent" ? agentWriteRefusedResponse(route) : null;
}
