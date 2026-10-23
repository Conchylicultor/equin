import { basename } from "node:path";
import { agentOpsFor, clearAgentOps, type StartedOp } from "./agent-ops";

/**
 * The stop half of the guards: refuse to let an agent end its turn while an op
 * it started is still running.
 *
 * `background-ops` can only advise — it speaks at the moment the op starts, and
 * an agent that ignores the advice ten tool calls later is exactly the agent
 * this exists for. A stop hook is the only place the harness asks a question we
 * can answer with "no": Claude Code lets `Stop`, `SubagentStop` and
 * `TeammateIdle` be refused with `{"decision":"block","reason":…}`, and hands
 * the reason to the agent as what to do instead.
 *
 * Two events matter, not one. `SubagentStop` covers a one-shot Agent-tool
 * subagent; `TeammateIdle` covers a NAMED teammate going idle — and the
 * teammates are what stalled in the incident this was written for
 * (`curriculum-web`, `curriculum-core`), so covering only the first would miss
 * the measured case entirely.
 *
 * ## Why this can never wedge a session
 *
 * Three independent reasons, because a stop hook that gets it wrong is far worse
 * than the bug it fixes:
 *
 * 1. It blocks only an agent that has an op of its OWN still running — a
 *    recorded start (`agent-ops`) AND a live marker for it right now.
 * 2. The remedy is one command, and that command always terminates: an
 *    `./equin await` caps itself at 8 minutes and exits.
 * 3. Claude Code overrides the hook after 8 consecutive blocks regardless.
 */

/** A live op in some checkout, as the reader sees it. `null` opId ⇒ pre-`opId` marker. */
export interface LiveOp {
  slug: string;
  op: string;
}

export type StopVerdict =
  { kind: "allow" } | { kind: "block"; reason: string; ops: StartedOp[] };

/**
 * Decide whether this agent may stop.
 *
 * Pure over the two readings, so the whole rule is testable without a session,
 * a filesystem or a running op — the entry point supplies them.
 *
 * `stopHookActive` is respected as a safety valve rather than a counter: when
 * the harness says it is already continuing this agent because of us, we have
 * already said our piece and saying it again adds nothing.
 */
/**
 * Is `stopping` the agent that recorded `recorded`?
 *
 * Usually an exact match: every hook payload measured so far carries `agent_id`,
 * which is what `background-ops` recorded. The fallback is for a `TeammateIdle`
 * that names the teammate instead — an in-process agent id encodes its name as
 * `a<name>-<hash>` (measured: teammate `wake-test` → `awake-test-f92bd72…`), and
 * without this a teammate's stop would silently never match its own ledger
 * entry, which is precisely the case this whole mechanism exists for.
 *
 * Fails OPEN: an encoding that changes makes this stop matching, so an agent
 * ends its turn un-nagged. It can never start blocking the wrong one.
 */
export function agentMatches(recorded: string, stopping: string): boolean {
  if (recorded === stopping) return true;
  // The hash tail must be matched, not just the prefix: teammate `wake-test`
  // would otherwise claim `awake-test-two-<hash>`, blocking an agent over
  // someone else's op. Hex and end-anchored, so only the real suffix qualifies.
  const name = stopping.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^a${name}-[0-9a-f]{8,}$`).test(recorded);
}

export function decideStop(
  started: readonly StartedOp[],
  live: readonly LiveOp[],
  stopHookActive: boolean,
): StopVerdict {
  if (stopHookActive) return { kind: "allow" };
  const liveKinds = new Set(live.map((l) => `${l.slug}:${l.op}`));
  const outstanding = started.filter((s) =>
    liveKinds.has(`${basename(s.cwd)}:${s.op}`),
  );
  if (outstanding.length === 0) return { kind: "allow" };

  const names = [...new Set(outstanding.map((o) => o.op))];
  return {
    kind: "block",
    ops: outstanding,
    reason:
      `You still have ${names.map((n) => `a \`${n}\``).join(" and ")} running that you started, and its ` +
      `completion notification will NOT be delivered to you — the harness files a subagent's ` +
      `notification under the parent session's queue, where nothing delivers it. If you stop now, ` +
      `nobody learns the outcome and whoever is waiting on you waits forever.\n\n` +
      `Run \`./equin await ${names.join(" ")}\` now. It blocks until the verdict is written and ` +
      `prints it, so the result reaches you as that call's own output. Exit 0 = success, 1 = failed, ` +
      `70 = still going (just run it again). Then report what it said.`,
  };
}

/**
 * The ops this agent started that are worth checking. Separated from
 * {@link decideStop} so the entry point does one cheap read before it does the
 * expensive one: an agent with no recorded op — the overwhelming majority of
 * stops — never touches the filesystem beyond this.
 */
export function outstandingFor(
  sessionId: string,
  agentId: string,
): StartedOp[] {
  return agentOpsFor(sessionId, agentId, agentMatches);
}

/** Nothing of this agent's is running; forget it so later stops cost nothing. */
export function releaseAgent(sessionId: string, agentId: string): void {
  clearAgentOps(sessionId, agentId, agentMatches);
}
