import { readdirSync } from "node:fs";
import { join } from "node:path";
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
import { sdkAgentProcesses, type AgentProcesses } from "../../core";
import { sdkAgentPidsDir } from "../../data-dirs";
import { agentPidsRoot } from "./paths";

const PID_SUFFIX = ".pid";

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** `namespace`'s agents whose pid file names a live pid. */
function liveAgents(namespace: string): { id: string; pid: number }[] {
  const dir = join(agentPidsRoot(), namespace);
  return entries(dir)
    .filter((name) => name.endsWith(PID_SUFFIX))
    .flatMap((name) => {
      const read = readPidFile(join(dir, name));
      return read.kind === "pid" && pidAlive(read.pid)
        ? [{ id: name.slice(0, -PID_SUFFIX.length), pid: read.pid }]
        : [];
    });
}

/** The conversation ids of `namespace`'s agents whose pid file names a live pid. */
export function liveAgentIds(namespace: string): string[] {
  return liveAgents(namespace).map((a) => a.id);
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
  let own = 0;
  for (const namespace of entries(agentPidsRoot()).sort()) {
    const running = liveAgentIds(namespace).length;
    if (namespace === here) own = running;
    else if (running > 0) elsewhere.push({ namespace, running });
  }
  return { here: own, elsewhere };
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
