import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { userInfo } from "node:os";
import {
  agentSessionEnv,
  agentSessionLaunch,
} from "@plugins/conversations/plugins/agent-launch/server";
import {
  defineDaemon,
  pidAlive,
  readPidFile,
  type DaemonInstance,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { backgroundPrefix } from "@plugins/packages/plugins/spawn-priority/server";
import type { AgentLaunchOptions } from "../../core";
import { liveAgentIds } from "./agent-processes";
import {
  AGENT_SCRIPT,
  agentDir,
  agentLogPath,
  agentPidPath,
  agentSocketPath,
  claudeUsagePath,
} from "./paths";

// The agent process itself: started detached — its own session and process
// group, so the backend's restart (which signals the backend's whole group) or
// crash does not reach it — and followed by its pid file. Nothing hosts it: no
// tmux, no supervisor of ours it would die with. Each one is an instance of
// one daemon declaration, so Debug → Background activity lists the agents.

export const sdkAgentDaemon = defineDaemon({
  name: "runtime-sdk.agent",
  description:
    "One Claude Agent SDK process per running conversation (bin/agent.ts), started detached so it outlives a backend restart; commanded over its socket, followed by its pid file.",
  startedBy: "on-demand",
  where: "every-worktree",
  restart: { kind: "never" },
});

/** This backend's record of each agent it started or re-attached. */
const instances = new Map<string, DaemonInstance>();

async function forget(id: string): Promise<void> {
  const instance = instances.get(id);
  if (!instance) return;
  instances.delete(id);
  await instance.stop();
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** One launch of an agent process, as `startAgentProcess` hands it back. */
export interface StartedAgent {
  /**
   * Settles, with the reason, once this launch's process is gone — it exited
   * (a crash on start included) or its record was dropped. Never rejects.
   */
  readonly exited: Promise<string>;
  /** What this launch has written to `agent.log` so far (stdout and stderr). */
  output(): string;
}

// The output a failure carries: enough for a stack trace or a usage error,
// bounded however much the process printed.
const MAX_OUTPUT_CHARS = 4_000;

/**
 * Start the agent process for `id`, from the options file already written in
 * its directory. Its stdout and stderr (the human log, the SDK's and the CLI's
 * warnings, a crash before the first event) append to `agent.log`.
 */
export async function startAgentProcess(
  id: string,
  options: AgentLaunchOptions,
): Promise<StartedAgent> {
  // A record left by an agent that exited: the declaration holds one instance
  // per key.
  await forget(id);
  // A pid file a killed agent left behind would read as this launch's pid.
  rmSync(agentPidPath(id), { force: true });
  mkdirSync(agentDir(id), { recursive: true });
  const command =
    backgroundPrefix() +
    // This backend's own bun, by path: the login shell's PATH is the account's.
    [
      process.execPath,
      AGENT_SCRIPT,
      "--dir",
      agentDir(id),
      "--socket",
      agentSocketPath(id),
      "--pid-file",
      agentPidPath(id),
      "--usage-file",
      claudeUsagePath(),
    ]
      .map(shellWord)
      .join(" ");
  const launch = agentSessionLaunch({
    env: agentSessionEnv(id),
    accountShell: userInfo().shell ?? "/bin/sh",
    claudeBin: options.claudeBin,
    command,
  });
  const logPath = agentLogPath(id);
  // `agent.log` appends across launches: this launch's output starts here.
  const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  let settle!: (reason: string) => void;
  const exited = new Promise<string>((resolve) => {
    settle = resolve;
  });
  const log = openSync(logPath, "a");
  try {
    instances.set(
      id,
      sdkAgentDaemon.launchDetached({
        instance: id,
        argv: launch.argv,
        env: launch.env,
        cwd: options.cwd,
        pidFile: agentPidPath(id),
        outputFd: log,
        onState: (t) => {
          if (t.state === "exited") settle(t.lastError ?? "exited");
          else if (t.state === "stopped") settle("stopped");
        },
      }),
    );
  } finally {
    closeSync(log);
  }
  return {
    exited,
    output: () => {
      const text = readFileSync(logPath).subarray(logOffset).toString("utf8");
      return text.length > MAX_OUTPUT_CHARS
        ? `…${text.slice(-MAX_OUTPUT_CHARS)}`
        : text;
    },
  };
}

/**
 * Kill an agent that would not stop on its own (it does not answer its socket,
 * or did not exit after `shutdown`), then drop its record. Idempotent: an agent
 * already gone is the goal.
 */
export async function killAgentProcess(id: string): Promise<void> {
  const read = readPidFile(agentPidPath(id));
  if (read.kind === "pid" && pidAlive(read.pid)) {
    process.kill(read.pid, "SIGKILL");
  }
  // What it would have removed on a clean exit.
  rmSync(agentPidPath(id), { force: true });
  rmSync(agentSocketPath(id), { force: true });
  await forget(id);
}

/** Drop the record of an agent that exited by itself (`shutdown`). */
export async function forgetAgentProcess(id: string): Promise<void> {
  await forget(id);
}

/** After a restart: follow every agent of this namespace that is still running. */
export function attachRunningAgents(): void {
  for (const id of liveAgentIds(runtimeNamespace())) {
    if (instances.has(id)) continue;
    instances.set(
      id,
      sdkAgentDaemon.attach({ instance: id, pidFile: agentPidPath(id) }),
    );
  }
}
