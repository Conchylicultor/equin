import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  joinAppPath,
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Which subagent started which long op — the fact nothing else in the session
 * records.
 *
 * The stop hook has to answer "is this agent about to walk away from its own
 * op?", and neither half of that is available at stop time. The op marker on
 * disk says a build is running in this checkout but not who asked for it; the
 * stop payload names the agent but not what it started. A parent's build would
 * otherwise pin every subagent under it, which is the opposite of the point.
 *
 * So the PreToolUse guard, which sees both at once, writes it down here.
 *
 * Session-scoped in tmpdir, exactly like `poll-loop`'s window: it is a fact
 * about one live conversation, worthless after it, and must never be something
 * a reader has to clean up. Entries are pruned by age on every read and write.
 */
export interface StartedOp {
  /** The subagent's `agent_id` from the hook payload. */
  agentId: string;
  /** The op subcommand — `build`, `check`, `test`, … */
  op: string;
  /** Where it was started, which is how the reader finds the right marker. */
  cwd: string;
  /** Epoch ms. */
  at: number;
}

/**
 * Long enough to cover the longest op anyone has measured (a p90 push is ~36
 * minutes; the tail is hours), short enough that a stale entry cannot haunt a
 * session all day. An entry older than this is dropped, and the stop hook then
 * stops blocking on it — the failure mode of forgetting is one un-awaited op,
 * which is where we already are today.
 */
const TTL_MS = 6 * 60 * 60 * 1000;

function stateFile(sessionId: string): AppPath {
  return joinAppPath(asAppPath(tmpdir()), `guard-agent-ops-${sessionId}.json`);
}

function prune(entries: StartedOp[], now: number): StartedOp[] {
  return entries.filter((e) => now - e.at <= TTL_MS);
}

export function readAgentOps(sessionId: string, now = Date.now()): StartedOp[] {
  const path = stateFile(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return prune(parsed as StartedOp[], now);
  } catch (err) {
    // A torn or hand-edited state file must never break a tool call or a stop.
    // Same rule as poll-loop's window: unreadable reads as empty.
    if (
      !(err instanceof SyntaxError) &&
      (err as NodeJS.ErrnoException).code == null
    )
      throw err;
    return [];
  }
}

/**
 * Record that `agentId` started `op`. Replaces any previous entry for the same
 * (agent, op, cwd): one agent's second build supersedes its first, and keeping
 * both would only make the reader pick.
 */
export function recordAgentOpStart(sessionId: string, entry: StartedOp): void {
  const kept = readAgentOps(sessionId, entry.at).filter(
    (e) =>
      !(
        e.agentId === entry.agentId &&
        e.op === entry.op &&
        e.cwd === entry.cwd
      ),
  );
  writeFileSync(stateFile(sessionId), JSON.stringify([...kept, entry]));
}

/** Every op this agent started and has not been released from. */
export function agentOpsFor(
  sessionId: string,
  agentId: string,
  matches: (recorded: string, stopping: string) => boolean = (a, b) => a === b,
  now = Date.now(),
): StartedOp[] {
  return readAgentOps(sessionId, now).filter((e) =>
    matches(e.agentId, agentId),
  );
}

/**
 * Forget this agent's ops. Called once the stop hook has established that none
 * of them is still running, so a later stop costs no reads at all.
 */
export function clearAgentOps(
  sessionId: string,
  agentId: string,
  matches: (recorded: string, stopping: string) => boolean = (a, b) => a === b,
): void {
  const kept = readAgentOps(sessionId).filter(
    (e) => !matches(e.agentId, agentId),
  );
  writeFileSync(stateFile(sessionId), JSON.stringify(kept));
}
