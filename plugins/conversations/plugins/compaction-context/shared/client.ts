// The hook's call, kept out of `bin/compaction-context.ts` so it runs (and is
// tested) against any base URL. Plain fetch and timers (and the import-free
// namespace grammar) only: no npm import, no zod — the CLI starts the hook on
// every compaction, and it must load fast with whatever node_modules the
// checkout has.

import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";

/** The endpoint's path — the same string as core/endpoints.ts (tested). */
export function compactionContextPath(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/compaction-context`;
}

/**
 * Where the hook reaches its backend: the namespace the pane's .mcp.json dials
 * too (`SINGULARITY_PARENT_HOST`). Throws on a value that is not one.
 */
export function backendBaseUrl(parentHost: string): string {
  return namespaceUrl(asNamespace(parentHost));
}

/** The backend answered, but not with the context: a bug, not a restart. */
export class CompactionContextRefusedError extends Error {}

/** How long a restarting backend may stay unreachable before the hook gives up. */
export const UNREACHABLE_GIVE_UP_MS = 40_000;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5_000;

/**
 * POST the compaction and return the context to inject (`""` for none).
 * Retries a network failure or a 5xx (a backend mid-restart) with backoff for
 * {@link UNREACHABLE_GIVE_UP_MS}, then throws its last error. A 4xx throws
 * {@link CompactionContextRefusedError} at once.
 */
export async function fetchCompactionContext({
  baseUrl,
  conversationId,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}: {
  baseUrl: string;
  conversationId: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<string> {
  const url = `${baseUrl}${compactionContextPath(conversationId)}`;
  const start = now();
  let backoff = BACKOFF_START_MS;
  for (;;) {
    let retryable: Error;
    try {
      const res = await fetch(url, { method: "POST" });
      const text = await res.text();
      if (res.ok) {
        const body = JSON.parse(text) as { context?: unknown };
        if (typeof body.context !== "string") {
          throw new CompactionContextRefusedError(
            `unexpected response from ${url}: ${text.slice(0, 200)}`,
          );
        }
        return body.context;
      }
      const error = `${url} answered ${res.status}: ${text.slice(0, 500)}`;
      if (res.status < 500) throw new CompactionContextRefusedError(error);
      retryable = new Error(error);
    } catch (err) {
      if (err instanceof CompactionContextRefusedError) throw err;
      retryable = err instanceof Error ? err : new Error(String(err));
    }
    if (now() - start >= UNREACHABLE_GIVE_UP_MS) throw retryable;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

/**
 * The hook's stdout for `context`: the SessionStart output that adds it to the
 * agent's context, or `""` (print nothing) when there is none.
 */
export function hookOutput(context: string): string {
  if (context.length === 0) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}
