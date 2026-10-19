import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Which `once` guards (`Guard.once`) each agent of a session has already been
 * told.
 *
 * Kept here rather than looked up in the transcript: a subagent's hook context
 * is not in the transcript the payload names (that is the parent's), so a
 * transcript search would re-send the hint to a subagent on every call.
 * Session-scoped in tmpdir like `agent-ops`: worthless once the session ends.
 */
function stateFile(sessionId: string): string {
  return join(tmpdir(), `guard-informed-once-${sessionId}.json`);
}

function read(sessionId: string): string[] {
  const path = stateFile(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch (err) {
    // A torn state file costs one repeated message, never a tool call.
    if (!(err instanceof SyntaxError)) throw err;
    return [];
  }
}

const keyOf = (agent: string, guard: string) => `${agent}\u0000${guard}`;

export function wasInformed(
  sessionId: string,
  agent: string,
  guard: string,
): boolean {
  return read(sessionId).includes(keyOf(agent, guard));
}

export function recordInformed(
  sessionId: string,
  agent: string,
  guards: readonly string[],
): void {
  if (guards.length === 0) return;
  const shown = new Set(read(sessionId));
  for (const g of guards) shown.add(keyOf(agent, g));
  writeFileSync(stateFile(sessionId), JSON.stringify([...shown]));
}
