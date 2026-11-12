import { relative, sep } from "node:path";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import {
  parsePidFile,
  pidAlive,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import {
  asNamespace,
  namespaceParts,
} from "@plugins/infra/plugins/namespace/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  agentPidFileAccount,
  sdkAgentProcesses,
  type AgentProcesses,
} from "../../core";
import { sdkAgentPidsDir } from "../../data-dirs";
import { sdkConversationIdsOf } from "../../server/internal/rows";
import { agentPidPath, agentPidsRoot } from "./paths";

const PID_SUFFIX = ".pid";

/** An agent as its pid file names it: its pid, then its Claude account. */
interface PidFileAgent {
  id: string;
  pid: number;
  /** `null` from an agent started before pid files named their account. */
  account: string | null;
}

async function entries(dir: AppPath): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * `namespace`'s agents whose pid file names a pid — read once each, pid and
 * account from the same text. Liveness is NOT read here: a pid is checked
 * alive (a signal-0 syscall, no disk) by whoever uses the answer, so a held
 * answer never vouches for an agent that died since.
 */
async function pidFileAgents(namespace: string): Promise<PidFileAgent[]> {
  const dir = joinAppPath(agentPidsRoot(), namespace);
  // Every file at once: in series, each read waits its turn behind whatever
  // else holds the event loop and the file system — a restart's resubscribe
  // storm made 41 reads one after another cost ~1 s.
  const read = await Promise.all(
    (await entries(dir))
      .filter((name) => name.endsWith(PID_SUFFIX))
      .map(async (name): Promise<PidFileAgent | null> => {
        let text: string;
        try {
          text = await readFile(joinAppPath(dir, name), "utf8");
        } catch (err) {
          // Exited between the listing and the read: its file is gone.
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
        const pidFile = parsePidFile(text);
        if (pidFile.kind !== "pid") return null;
        return {
          id: name.slice(0, -PID_SUFFIX.length),
          pid: pidFile.pid,
          account: agentPidFileAccount(text),
        };
      }),
  );
  return read.filter((a): a is PidFileAgent => a !== null);
}

/**
 * The Claude account `id`'s running agent signs in as, read from the pid file
 * the agent itself wrote — the one authority on it (the stop row's `account`
 * is the consumer's copy, and a copy can be stale). `not-running` while no
 * live pid is named; `account: null` for an agent started before pid files
 * named their account.
 */
export async function runningAgentAccount(
  id: string,
): Promise<
  { kind: "not-running" } | { kind: "running"; account: string | null }
> {
  let text: string;
  try {
    text = await readFile(agentPidPath(id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "not-running" };
    throw err;
  }
  const read = parsePidFile(text);
  if (read.kind !== "pid" || !pidAlive(read.pid))
    return { kind: "not-running" };
  return { kind: "running", account: agentPidFileAccount(text) };
}

/** The conversation ids of `namespace`'s agents whose pid file names a live pid. */
export async function liveAgentIds(namespace: string): Promise<string[]> {
  return (await pidFileAgents(namespace))
    .filter((a) => pidAlive(a.pid))
    .map((a) => a.id);
}

/**
 * This backend's sdk conversations whose agent runs — its pid file names a live
 * pid — of `ids` when given, else every one. Liveness is the process's own
 * evidence, read for every row whatever its status: the reconciler derives the
 * status from this answer, so it must never be filtered by it (a `gone` row
 * whose agent came up late would otherwise stay `gone` while the agent works).
 */
export async function runningAgentIds(
  ids?: readonly string[],
): Promise<string[]> {
  const running = await liveAgentIds(runtimeNamespace());
  const wanted = ids ? new Set(ids) : null;
  return sdkConversationIdsOf(
    wanted ? running.filter((id) => wanted.has(id)) : running,
  );
}

/** Whether `namespace` is served from the worktree checkout named `checkout`, in any composition. */
function servedFrom(namespace: string, checkout: string): boolean {
  const parts = namespaceParts(asNamespace(namespace));
  return (parts.kind === "label" ? parts.label : parts.checkout) === checkout;
}

/**
 * Stop every agent a backend served from the worktree checkout `checkout`
 * launched — the one cross-namespace command, so it goes by pid, not by socket
 * (paths.ts spells only this backend's own). SIGTERM is the agent's clean exit:
 * it writes its `exited` event and removes its pid file, so that backend, when
 * it next runs, reads an agent that exited.
 */
export async function stopCheckoutAgents(checkout: string): Promise<void> {
  if (servedFrom(runtimeNamespace(), checkout)) {
    throw new Error(
      `refusing to stop the agents of ${checkout}: this backend is served from it`,
    );
  }
  for (const namespace of await entries(agentPidsRoot())) {
    if (!servedFrom(namespace, checkout)) continue;
    for (const { pid } of await pidFileAgents(namespace)) {
      if (!pidAlive(pid)) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        // Exited between the liveness read and the signal: the goal.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
  }
}

/**
 * Every namespace's agents as their pid files last read, kept while the value
 * is watched: a pid-file change re-reads only the namespace it happened in
 * (`dirty`), so a recount is O(changed namespaces) of disk, never one
 * `readdir` + a read per agent across every namespace on the machine (~113
 * dirs: 2+ s of blocked thread per change, in every backend, when it was
 * read whole and synchronously).
 */
const byNamespace = new Map<string, PidFileAgent[]>();
/** What the next count must re-read: some namespaces, or everything. */
let dirty: Set<string> | "all" = "all";
/** One count at a time, so an older read never lands after a newer one. */
const counting = createKeyedMutex();

function markDirty(namespace: string | "all"): void {
  if (namespace === "all") dirty = "all";
  else if (dirty !== "all") dirty.add(namespace);
}

/** The namespace a changed path under the pid-files root belongs to. */
function namespaceOfChange(root: string, path: string): string | "all" {
  const rel = relative(root, path);
  const first = rel.split(sep)[0] ?? "";
  // The root itself (or something outside it): nothing names one namespace.
  return first === "" || first === ".." ? "all" : first;
}

async function refresh(): Promise<void> {
  const pending = dirty;
  dirty = new Set();
  try {
    await reread(pending);
  } catch (err) {
    // What it did not finish is unknown: the next count reads everything.
    markDirty("all");
    throw err;
  }
}

async function reread(pending: Set<string> | "all"): Promise<void> {
  // Every namespace at once, for the reason `pidFileAgents` reads every file
  // at once: one namespace dir per worktree that ever launched an agent (~80).
  if (pending === "all") {
    const namespaces = await entries(agentPidsRoot());
    const agents = await Promise.all(namespaces.map(pidFileAgents));
    byNamespace.clear();
    namespaces.forEach((namespace, i) =>
      byNamespace.set(namespace, agents[i] ?? []),
    );
    return;
  }
  const namespaces = [...pending];
  const agents = await Promise.all(namespaces.map(pidFileAgents));
  namespaces.forEach((namespace, i) => {
    const found = agents[i] ?? [];
    if (found.length > 0) byNamespace.set(namespace, found);
    else byNamespace.delete(namespace);
  });
}

async function countAgents(): Promise<AgentProcesses> {
  // Not watched (a one-off read): nothing keeps the held reads current.
  if (notifiers.size === 0) dirty = "all";
  await counting.run("count", refresh);
  const here = runtimeNamespace();
  const elsewhere: AgentProcesses["elsewhere"] = [];
  const byAccount: AgentProcesses["byAccount"] = {};
  let own = 0;
  for (const namespace of [...byNamespace.keys()].sort()) {
    // An agent killed outright leaves its pid file: liveness is read now.
    const agents = byNamespace.get(namespace)!.filter((a) => pidAlive(a.pid));
    const running = agents.length;
    if (namespace === here) own = running;
    else if (running > 0) elsewhere.push({ namespace, running });
    for (const agent of agents)
      if (agent.account !== null)
        byAccount[agent.account] = (byAccount[agent.account] ?? 0) + 1;
  }
  return { here: own, elsewhere, byAccount };
}

const notifiers = new Set<() => void>();
const recountListeners = new Set<() => void>();

/**
 * Re-count now: an agent this backend found gone outright (killed, so it left
 * its pid file behind and no watch event says so).
 */
export function recountAgentProcesses(): void {
  for (const notify of notifiers) notify();
  for (const hear of recountListeners) hear();
}

/**
 * Hear every {@link recountAgentProcesses} — the one signal for an agent that
 * died without removing its pid file. Returns the unsubscribe.
 */
export function onAgentProcessesRecount(hear: () => void): () => void {
  recountListeners.add(hear);
  return () => {
    recountListeners.delete(hear);
  };
}

/**
 * `runtime-sdk.agent-processes`: recounted whenever a pid file appears or goes
 * under `locks/sdk-agents/` (an agent of any namespace starting or exiting —
 * that tree holds nothing else, so it never wakes on an events append), and on
 * {@link recountAgentProcesses}.
 */
export const agentProcessesServed = serveValue(sdkAgentProcesses, {
  source: "external",
  changes: "notified",
  throttleMs: 250,
  loader: countAgents,
  whileSubscribed: async (_params, notify) => {
    notifiers.add(notify);
    const root = await sdkAgentPidsDir.ensure();
    const release = await acquireDirWatch({
      dir: root,
      scope: "subtree",
      onChange: (events) => {
        for (const e of events) markDirty(namespaceOfChange(root, e.path));
        notify();
      },
      // Events may have been dropped: anything may have changed unheard.
      onLost: () => {
        markDirty("all");
        notify();
      },
    });
    // What happened while nothing watched was heard by no one: the first
    // count after the watch opens reads everything. That count is this
    // subscription's own first read — the runtime settles this start before
    // it (`onFirstSubscribe`), so the watch already hears whatever lands
    // during it. No notify here: one would only queue a second full count of
    // every namespace behind the first (both ran on every cold start, ~1 s
    // each on a busy host).
    markDirty("all");
    return () => {
      notifiers.delete(notify);
      release();
    };
  },
});
