import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import {
  pidAlive,
  readPidFile,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import {
  asNamespace,
  namespaceParts,
} from "@plugins/infra/plugins/namespace/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  agentPidFileAccount,
  sdkAgentProcesses,
  type AgentProcesses,
} from "../../core";
import { sdkAgentPidsDir } from "../../data-dirs";
import { sdkConversationIdsOf } from "../../server/internal/rows";
import { agentPidsRoot } from "./paths";

const PID_SUFFIX = ".pid";

function entries(dir: AppPath): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** `namespace`'s agents whose pid file names a live pid. */
function liveAgents(
  namespace: string,
): { id: string; pid: number; path: AppPath }[] {
  const dir = joinAppPath(agentPidsRoot(), namespace);
  return entries(dir)
    .filter((name) => name.endsWith(PID_SUFFIX))
    .flatMap((name) => {
      const path = joinAppPath(dir, name);
      const read = readPidFile(path);
      return read.kind === "pid" && pidAlive(read.pid)
        ? [{ id: name.slice(0, -PID_SUFFIX.length), pid: read.pid, path }]
        : [];
    });
}

/**
 * The Claude account a live agent's pid file names — `null` from an agent
 * started before pid files named it, or one that exited since its liveness
 * was read (its file is gone: the next recount drops it).
 */
function agentAccount(pidFile: AppPath): string | null {
  let text: string;
  try {
    text = readFileSync(pidFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return agentPidFileAccount(text);
}

/** The conversation ids of `namespace`'s agents whose pid file names a live pid. */
export function liveAgentIds(namespace: string): string[] {
  return liveAgents(namespace).map((a) => a.id);
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
  const running = liveAgentIds(runtimeNamespace());
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
export function stopCheckoutAgents(checkout: string): void {
  if (servedFrom(runtimeNamespace(), checkout)) {
    throw new Error(
      `refusing to stop the agents of ${checkout}: this backend is served from it`,
    );
  }
  for (const namespace of entries(agentPidsRoot())) {
    if (!servedFrom(namespace, checkout)) continue;
    for (const { pid } of liveAgents(namespace)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        // Exited between the liveness read and the signal: the goal.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
  }
}

function countAgents(): AgentProcesses {
  const here = runtimeNamespace();
  const elsewhere: AgentProcesses["elsewhere"] = [];
  const byAccount: AgentProcesses["byAccount"] = {};
  let own = 0;
  for (const namespace of entries(agentPidsRoot()).sort()) {
    const agents = liveAgents(namespace);
    const running = agents.length;
    if (namespace === here) own = running;
    else if (running > 0) elsewhere.push({ namespace, running });
    for (const agent of agents) {
      const account = agentAccount(agent.path);
      if (account !== null) byAccount[account] = (byAccount[account] ?? 0) + 1;
    }
  }
  return { here: own, elsewhere, byAccount };
}

const notifiers = new Set<() => void>();

/**
 * Re-count now: an agent this backend found gone outright (killed, so it left
 * its pid file behind and no watch event says so).
 */
export function recountAgentProcesses(): void {
  for (const notify of notifiers) notify();
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
    const release = await acquireDirWatch({
      dir: sdkAgentPidsDir.ensure(),
      scope: "subtree",
      onChange: () => notify(),
    });
    // A pid file written between the first count and the watch opening
    // produced no event; one recount closes that gap.
    notify();
    return () => {
      notifiers.delete(notify);
      release();
    };
  },
});
