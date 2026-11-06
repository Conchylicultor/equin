import { rm, rmdir } from "node:fs/promises";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  pidAlive,
  readPidFile,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { readdir } from "@plugins/packages/plugins/timed-fs/core";

// An agent's directory (`<agentsRoot>/<ns>/<conversationId>/`: launch.json,
// events.jsonl, agent.log) is worth something only while its conversation can
// run again — and a conversation runs in its attempt's workspace. So the
// directory goes when that workspace does: never by age, never while its agent
// runs. Two places hold one:
//
// - THIS backend's namespace (`ownNamespace`) — the agents it launched; each
//   directory belongs to the conversation of its name, whose attempt this DB
//   records.
// - A checkout's namespace (`<attemptId>/`) — the agents a worktree's own
//   build launched while testing. The checkout owns the whole namespace, so it
//   goes with that checkout's workspace.
//
// Gone means the workspace's reaper deleted it (the announcement,
// `reclaimAttemptAgentDirs`) — or, for a directory an announcement missed, that
// the workspace is not on disk (`sweepReclaimedAgentDirs`, the same rule).
// Whatever the DB cannot place (no conversation row, no attempt row, a
// namespace that is no attempt) is kept: unknown is not gone.

/** Where the agent directories and their pid files live. */
export interface AgentDirRoots {
  /** `state/sdk-agents/` — `<ns>/<conversationId>/` under it. */
  agentsRoot: AppPath;
  /** `locks/sdk-agents/` — `<ns>/<conversationId>.pid` under it. */
  pidsRoot: AppPath;
  /** The namespace this backend launches its own agents under. */
  ownNamespace: string;
}

/** What this backend's DB and the workspace registry know. */
export interface AgentDirFacts {
  /** Each conversation's attempt; a conversation this DB has no row of is absent. */
  attemptsOfConversations(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /** The conversations of `attemptIds`. */
  conversationsOfAttempts(attemptIds: readonly string[]): Promise<string[]>;
  /**
   * Whether each attempt's workspace is on disk; an attempt this DB has no row
   * of (so no workspace to look for) is absent.
   */
  workspacePresent(
    attemptIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>>;
}

export interface AgentDirsReclaim {
  /** Agent directories deleted (or, in a dry run, that would be). */
  removed: number;
  /** Kept: their agent runs (or its pid file is being written). */
  live: number;
  /** Kept: their workspace is still on disk. */
  present: number;
  /** Kept: this DB cannot say which attempt they belong to. */
  unknown: number;
  /** Namespace directories deleted once empty. */
  namespacesRemoved: number;
}

const emptyReclaim = (): AgentDirsReclaim => ({
  removed: 0,
  live: 0,
  present: 0,
  unknown: 0,
  namespacesRemoved: 0,
});

/**
 * The announcement's half: `attemptIds`' workspaces were just deleted, so
 * delete their agent directories — every one in each attempt's own namespace,
 * and those of their conversations in this backend's — skipping any whose
 * agent still runs. Idempotent.
 */
export async function reclaimAttemptAgentDirs(
  attemptIds: readonly string[],
  roots: AgentDirRoots,
  facts: AgentDirFacts,
): Promise<AgentDirsReclaim> {
  const out = emptyReclaim();
  for (const attemptId of attemptIds) {
    if (attemptId === roots.ownNamespace) continue;
    await removeNamespace(roots, attemptId, out, false);
  }
  const ids = await facts.conversationsOfAttempts(attemptIds);
  for (const id of ids) {
    await removeAgentDir(roots, roots.ownNamespace, id, out, false);
  }
  return out;
}

/**
 * The backstop — the same rule for whatever an announcement missed (a reap
 * before this existed, a handler that failed): every agent directory whose
 * workspace is not on disk, and whose agent does not run, is deleted. With
 * `dryRun`, nothing is deleted and the counts say what would be.
 */
export async function sweepReclaimedAgentDirs(
  roots: AgentDirRoots,
  facts: AgentDirFacts,
  opts: { dryRun: boolean },
): Promise<AgentDirsReclaim> {
  const out = emptyReclaim();
  const namespaces = await dirsIn(roots.agentsRoot);

  // This backend's own agents, by their conversation's attempt.
  if (namespaces.includes(roots.ownNamespace)) {
    const ids = await dirsIn(joinAppPath(roots.agentsRoot, roots.ownNamespace));
    const attemptOf = await facts.attemptsOfConversations(ids);
    const present = await facts.workspacePresent([
      ...new Set(attemptOf.values()),
    ]);
    for (const id of ids) {
      const attemptId = attemptOf.get(id);
      const isPresent =
        attemptId === undefined ? undefined : present.get(attemptId);
      if (isPresent === undefined) out.unknown++;
      else if (isPresent) out.present++;
      else
        await removeAgentDir(roots, roots.ownNamespace, id, out, opts.dryRun, {
          stillGone: () => stillGone(facts, attemptId!),
          present: () => out.present++,
        });
    }
  }

  // The checkouts' namespaces, each by its own attempt's workspace.
  const others = namespaces.filter((ns) => ns !== roots.ownNamespace);
  const present = await facts.workspacePresent(others);
  for (const ns of others) {
    const isPresent = present.get(ns);
    if (isPresent === false) {
      await removeNamespace(roots, ns, out, opts.dryRun, {
        stillGone: () => stillGone(facts, ns),
        present: () => out.present++,
      });
      continue;
    }
    const count = (await dirsIn(joinAppPath(roots.agentsRoot, ns))).length;
    if (isPresent) out.present += count;
    else out.unknown += count;
    // An empty namespace holds nothing to lose, whoever owns it; the next
    // launch under it makes it again.
    if (count === 0 && !opts.dryRun) await removeEmptyNamespace(roots, ns, out);
    else if (count === 0) out.namespacesRemoved++;
  }
  return out;
}

/**
 * The backstop's last look before a removal: its first read of every
 * workspace can be minutes old by the time it reaches a directory (a resume
 * may have brought the workspace back), so each one is asked again.
 */
async function stillGone(
  facts: AgentDirFacts,
  attemptId: string,
): Promise<boolean> {
  return (await facts.workspacePresent([attemptId])).get(attemptId) === false;
}

/**
 * What a removal checks again just before it deletes (the backstop): whether
 * the workspace is still gone, and what to count when it is back.
 */
interface Recheck {
  stillGone(): Promise<boolean>;
  present(): void;
}

/** Every agent directory of `ns` whose agent is not running, then `ns` itself once empty. */
async function removeNamespace(
  roots: AgentDirRoots,
  ns: string,
  out: AgentDirsReclaim,
  dryRun: boolean,
  recheck?: Recheck,
): Promise<void> {
  const ids = await dirsIn(joinAppPath(roots.agentsRoot, ns));
  const removedBefore = out.removed;
  for (const id of ids)
    await removeAgentDir(roots, ns, id, out, dryRun, recheck);
  if (dryRun) {
    if (out.removed - removedBefore === ids.length) out.namespacesRemoved++;
    return;
  }
  await removeEmptyNamespace(roots, ns, out);
}

/** One agent directory and its pid file, unless its agent runs (or, rechecked, its workspace is back). */
async function removeAgentDir(
  roots: AgentDirRoots,
  ns: string,
  id: string,
  out: AgentDirsReclaim,
  dryRun: boolean,
  recheck?: Recheck,
): Promise<void> {
  const pidFile = joinAppPath(roots.pidsRoot, ns, `${id}.pid`);
  if (await agentMayRun(pidFile)) {
    out.live++;
    return;
  }
  if (recheck && !dryRun && !(await recheck.stillGone())) {
    recheck.present();
    return;
  }
  out.removed++;
  if (dryRun) return;
  await rm(joinAppPath(roots.agentsRoot, ns, id), {
    recursive: true,
    force: true,
  });
  // What a killed agent left behind; a clean exit removed it already.
  await rm(pidFile, { force: true });
}

/** `ns`'s directory and its pid directory, each only once empty. */
async function removeEmptyNamespace(
  roots: AgentDirRoots,
  ns: string,
  out: AgentDirsReclaim,
): Promise<void> {
  if (await removeIfEmpty(joinAppPath(roots.agentsRoot, ns)))
    out.namespacesRemoved++;
  await removeIfEmpty(joinAppPath(roots.pidsRoot, ns));
}

/**
 * Whether the agent may be running: its pid file names a live pid, or cannot
 * be read (being written as it starts). A pid since reused by another process
 * only keeps the directory until the next pass.
 */
async function agentMayRun(pidFile: AppPath): Promise<boolean> {
  const read = await readPidFile(pidFile);
  if (read.kind === "absent") return false;
  if (read.kind === "unreadable") return true;
  return pidAlive(read.pid);
}

/** The subdirectories of `dir`; none when it does not exist. */
async function dirsIn(dir: AppPath): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Remove `dir` if empty; true when it went (or was already gone). */
async function removeIfEmpty(dir: AppPath): Promise<boolean> {
  try {
    await rmdir(dir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY") return false;
    if (code === "ENOENT") return false;
    throw err;
  }
}
