import { serveValue } from "@plugins/network/plugins/live/server";
import {
  MCP_HEALTH_MAX_DEGRADED,
  mcpHealth,
  type McpDegraded,
  type McpHealth,
} from "../../core";

/**
 * What this process's MCP requests saw (`McpHealth`): the latest request's
 * outcome, and every contribution whose latest run threw. In memory — it is
 * this backend's own server, and a restart is a fresh one.
 */
let requests: McpHealth["requests"] = { kind: "none" };
const degraded = new Map<string, McpDegraded>();
const changedListeners = new Set<() => void>();

/** The health value as of now. */
export function currentMcpHealth(): McpHealth {
  const failing = [...degraded.values()].sort((a, b) => b.at - a.at);
  return {
    requests,
    degraded: failing.slice(0, MCP_HEALTH_MAX_DEGRADED),
    degradedMore: Math.max(0, failing.length - MCP_HEALTH_MAX_DEGRADED),
  };
}

function changed(): void {
  for (const fn of changedListeners) fn();
}

/**
 * One request's outcome. Only a change is announced: every request of a
 * healthy server leaves the value as it was, so agent traffic pushes nothing.
 */
export function recordMcpRequest(
  outcome: { ok: true } | { ok: false; message: string },
): void {
  if (outcome.ok) {
    if (requests.kind === "ok") return;
    requests = { kind: "ok" };
  } else {
    requests = { kind: "failing", message: outcome.message, at: Date.now() };
  }
  changed();
}

/** One contribution's run (`runContribution`): a throw lists it, a clean run clears it. */
export function recordMcpContribution(
  what: string,
  outcome: { ok: true } | { ok: false; message: string },
): void {
  if (outcome.ok) {
    if (degraded.delete(what)) changed();
    return;
  }
  degraded.set(what, { what, message: outcome.message, at: Date.now() });
  changed();
}

/** Test seam: back to a fresh process's state. */
export function resetMcpHealth(): void {
  requests = { kind: "none" };
  degraded.clear();
}

// External: the truth is this process's own request path, which tells the
// value when what it saw moved. Pushed (the `liveValue` default): one small
// value, read by the always-mounted health dot.
export const mcpHealthServed = serveValue(mcpHealth, {
  source: "external",
  changes: "notified",
  loader: () => Promise.resolve(currentMcpHealth()),
  whileSubscribed: (_params, notify) => {
    const fn = () => notify();
    changedListeners.add(fn);
    return () => {
      changedListeners.delete(fn);
    };
  },
});
