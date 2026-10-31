// The Stop hook's logic, kept out of `bin/stop-gate.ts` so it runs (and is
// tested) against any base URL and any stdin. Plain fetch and timers (and the
// import-free namespace grammar) only: no npm import, no zod — the CLI starts
// the hook every time the agent ends a turn, and it must load fast with
// whatever node_modules the checkout has.

import { asNamespaceOrigin } from "@plugins/infra/plugins/namespace/core";

/** The endpoint's path — the same string as core/endpoints.ts (tested). */
export function stopGatePath(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/stop-gate`;
}

/**
 * Where the hook reaches its backend: the origin the agent's .mcp.json dials
 * too (`EQUIN_PARENT_URL`). Throws on a value that is not one.
 */
export function backendBaseUrl(parentUrl: string): string {
  return asNamespaceOrigin(parentUrl);
}

/** The backend's answer, as the hook reads it. */
export interface StopGateAnswer {
  decision: "allow" | "block";
  reason: string | null;
}

/** The backend answered, but not with a decision: a bug, not a restart. */
export class StopGateRefusedError extends Error {}

/**
 * How long a restarting backend may stay unreachable before the hook gives up
 * and lets the agent stop — below the hook's own timeout (core/hook.ts).
 */
export const UNREACHABLE_GIVE_UP_MS = 15_000;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 2_000;

function parseAnswer(url: string, text: string): StopGateAnswer {
  const body = JSON.parse(text) as { decision?: unknown; reason?: unknown };
  if (
    (body.decision !== "allow" && body.decision !== "block") ||
    (body.reason !== null && typeof body.reason !== "string")
  ) {
    throw new StopGateRefusedError(
      `unexpected response from ${url}: ${text.slice(0, 200)}`,
    );
  }
  return { decision: body.decision, reason: body.reason };
}

/**
 * Ask the backend whether the agent may stop. Retries a network failure or a
 * 5xx (a backend mid-restart) with backoff for {@link UNREACHABLE_GIVE_UP_MS},
 * then throws its last error. A 4xx or a malformed answer throws
 * {@link StopGateRefusedError} at once.
 */
export async function fetchStopGate({
  baseUrl,
  conversationId,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}: {
  baseUrl: string;
  conversationId: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<StopGateAnswer> {
  const url = `${baseUrl}${stopGatePath(conversationId)}`;
  const start = now();
  let backoff = BACKOFF_START_MS;
  for (;;) {
    let retryable: Error;
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.ok) return parseAnswer(url, text);
      const error = `${url} answered ${res.status}: ${text.slice(0, 500)}`;
      if (res.status < 500) throw new StopGateRefusedError(error);
      retryable = new Error(error);
    } catch (err) {
      if (err instanceof StopGateRefusedError) throw err;
      if (err instanceof SyntaxError) {
        throw new StopGateRefusedError(
          `${url} answered non-JSON: ${err.message}`,
        );
      }
      retryable = err instanceof Error ? err : new Error(String(err));
    }
    if (now() - start >= UNREACHABLE_GIVE_UP_MS) throw retryable;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

/**
 * Whether the CLI is already continuing because a Stop hook blocked
 * (`stop_hook_active` in the hook's stdin JSON). The hook then allows: ONE
 * forced continuation per stop attempt, never a loop. Throws on stdin that is
 * not the hook's JSON object.
 */
export function stopHookActive(stdin: string): boolean {
  const input = JSON.parse(stdin) as unknown;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(
      `Stop hook stdin is not a JSON object: ${stdin.slice(0, 200)}`,
    );
  }
  return (input as { stop_hook_active?: unknown }).stop_hook_active === true;
}

/**
 * The hook's stdout for an answer: the Stop output that sends the agent back
 * to work with the reason, or `""` (print nothing) to let it stop.
 */
export function hookOutput(answer: StopGateAnswer): string {
  if (answer.decision !== "block") return "";
  return JSON.stringify({
    decision: "block",
    reason: answer.reason ?? "A stop gate blocked this stop.",
  });
}
