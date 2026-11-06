import { renameSync, writeFileSync } from "node:fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import {
  joinAppPath,
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * What each agent of a session has already been told, so it is not told twice:
 * the `once` guards' informs (`Guard.once`, keyed by guard name) and the
 * repeatable denials it has seen (`DenyVerdict.allowOnRepeat`, keyed by
 * `repeatKey` — seen once, the identical call goes through).
 *
 * Kept here rather than looked up in the transcript: a subagent's hook context
 * is not in the transcript the payload names (that is the parent's), so a
 * transcript search would re-send the hint to a subagent on every call.
 * Session-scoped in tmpdir like `agent-ops`: worthless once the session ends.
 */
function stateFile(sessionId: string): AppPath {
  return joinAppPath(
    asAppPath(tmpdir()),
    `guard-informed-once-${sessionId}.json`,
  );
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

/**
 * The identity of a repeatable denial: which guard refused which call, where.
 * The call is its whole input but `description` — the label the agent writes
 * for the user, which never changes what runs — and the cwd, which resolves
 * every relative path in it.
 */
export function repeatKey(
  guard: string,
  tool: string,
  cwd: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const { description: _label, ...call } = input;
  return `${guard}#${hashHex(JSON.stringify([tool, cwd, call]))}`;
}

const keyOf = (agent: string, what: string) => `${agent}\u0000${what}`;

/** `what`: a `once` guard's name, or a `repeatKey`. */
export function wasInformed(
  sessionId: string,
  agent: string,
  what: string,
): boolean {
  return read(sessionId).includes(keyOf(agent, what));
}

export function recordInformed(
  sessionId: string,
  agent: string,
  told: readonly string[],
): void {
  if (told.length === 0) return;
  const shown = new Set(read(sessionId));
  for (const w of told) shown.add(keyOf(agent, w));
  // Write-then-rename: parallel tool calls run the hook as concurrent
  // processes, and a reader catching a half-written file would read it as
  // empty — and its own write would then drop every key recorded so far.
  const path = stateFile(sessionId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...shown]));
  renameSync(tmp, path);
}
