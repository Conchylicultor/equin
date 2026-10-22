import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
import { claudeAccountIds } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import {
  readClaudeAccounts,
  selectClaudeAccountById,
} from "@plugins/infra/plugins/claude-cli/plugins/accounts/machine";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { PGREP, PS } from "@plugins/infra/plugins/paths/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { backgroundPrefix } from "@plugins/packages/plugins/spawn-priority/server";
import { launchAccount, type AgentLaunchOptions } from "../../core";
import { liveAgentIds } from "./agent-processes";
import { readClaudeUsage } from "./claude-usage";
import {
  AGENT_SCRIPT,
  agentDir,
  agentLogPath,
  agentPidPath,
  agentSocketPath,
  claudeUsagePath,
  ownAgentPidsDir,
} from "./paths";

// The agent process itself: started detached — its own session and process
// group, so the backend's restart (which signals the backend's whole group) or
// crash does not reach it — and followed by its pid file. Nothing hosts it: no
// tmux, no supervisor of ours it would die with. Each one is an instance of
// one daemon declaration, so Debug → Background activity lists the agents.
//
// The pid file exists exactly while the agent is alive: the agent removes it
// only as it really exits, and this backend only after killing it. So "alive"
// is always the pid file naming a live pid — never the agent's own `exited`
// line, which it writes before it exits (and on 2026-10-20 did not exit).

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
 * The Claude account this launch runs on: the active one — or, when
 * auto-switch is on and the active one's limit is reached, the roomiest other
 * account, which then becomes the active one (the next launches follow it).
 * Read at every process start, so a switch reaches an agent at its next start.
 */
function chooseLaunchAccount(): string {
  const chosen = nextLaunchAccount();
  if (chosen !== readClaudeAccounts().active) selectClaudeAccountById(chosen);
  return chosen;
}

/** The account an agent process started now would run on — a read, selecting nothing. */
export function nextLaunchAccount(): string {
  const state = readClaudeAccounts();
  return launchAccount({
    ids: claudeAccountIds(state),
    active: state.active,
    autoSwitch: state.autoSwitch,
    byAccount: readClaudeUsage().byAccount,
    now: Date.now(),
  });
}

/**
 * Start the agent process for `id`, from the options file already written in
 * its directory. Its stdout and stderr (the human log, the SDK's and the CLI's
 * warnings, a crash before the first event) append to `agent.log`.
 */
export async function startAgentProcess(
  id: string,
  options: AgentLaunchOptions,
): Promise<StartedAgent> {
  // At most one agent per conversation. A caller launches only when no agent
  // answers its socket, so a live predecessor here is one whose exit stalled
  // or that is wedged: it cannot be asked to stop, and is killed.
  const predecessor = await killAgentProcess(id);
  if (predecessor !== null) {
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agent ${id}: a launch found its previous agent (pid ${String(predecessor)}) still alive without answering its socket, and killed it and its CLI first — something let an agent outlive its exit`,
      data: { errorType: "SdkAgentDuplicate", label: "runtime-sdk.exit" },
    });
  }
  mkdirSync(agentDir(id), { recursive: true });
  const account = chooseLaunchAccount();
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
      "--account",
      account,
      "--usage-file",
      claudeUsagePath(account),
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
 * The agent's pid, while its pid file names a live process that is this
 * conversation's agent — its argv carries this pid file. A file a killed agent
 * left behind can name a pid the system has since given to another process,
 * which must never be killed for it.
 */
function livePid(id: string): number | null {
  const pidFile = agentPidPath(id);
  const read = readPidFile(pidFile);
  if (read.kind !== "pid" || !pidAlive(read.pid)) return null;
  const ps = spawnSync(PS, ["-ww", "-o", "command=", "-p", String(read.pid)], {
    encoding: "utf8",
  });
  // ps exits 1 when the pid is gone (it exited since the liveness check).
  if (ps.status === 1) return null;
  if (ps.status !== 0) {
    throw new Error(
      `ps -p ${String(read.pid)} failed (${String(ps.status ?? ps.signal)}): ${ps.stderr.trim()}`,
    );
  }
  return ps.stdout.includes(`--pid-file ${pidFile}`) ? read.pid : null;
}

/** The direct children of `pid` — an agent's CLI. */
function childPids(pid: number): number[] {
  const r = spawnSync(PGREP, ["-P", String(pid)], { encoding: "utf8" });
  // pgrep exits 1 when nothing matches.
  if (r.status === 1) return [];
  if (r.status !== 0) {
    throw new Error(
      `pgrep -P ${String(pid)} failed (${String(r.status ?? r.signal)}): ${r.stderr.trim()}`,
    );
  }
  return r.stdout.split("\n").filter(Boolean).map(Number);
}

/** SIGKILL `pid`; one that exited since it was looked up is the goal too. */
function sigkill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/**
 * Kill an agent that would not stop on its own (it does not answer its socket,
 * or did not exit after `shutdown`) — its CLI first, which would otherwise
 * outlive it holding the session — then drop its record. Idempotent: an agent
 * already gone is the goal. Returns the pid it killed, or null when none was
 * alive.
 */
export async function killAgentProcess(id: string): Promise<number | null> {
  const pid = livePid(id);
  if (pid !== null) {
    for (const child of childPids(pid)) sigkill(child);
    sigkill(pid);
  }
  // What it would have removed on a clean exit.
  rmSync(agentPidPath(id), { force: true });
  rmSync(agentSocketPath(id), { force: true });
  await forget(id);
  return pid;
}

/**
 * Wait until `id`'s agent is gone — its pid file removed (it does so only as
 * it really exits) or naming a dead pid — or `timeoutMs` passes. Woken by the
 * watch on the pid files' directory.
 */
export async function awaitAgentExit(
  id: string,
  timeoutMs: number,
): Promise<"exited" | "timeout"> {
  if (livePid(id) === null) return "exited";
  const { promise, resolve } = Promise.withResolvers<"exited" | "timeout">();
  const timer = setTimeout(() => resolve("timeout"), timeoutMs);
  const release = await acquireDirWatch({
    dir: ownAgentPidsDir(),
    scope: "children",
    onChange: () => {
      if (livePid(id) === null) resolve("exited");
    },
  });
  // An exit between the first look and the watch opening sent no event.
  if (livePid(id) === null) resolve("exited");
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    release();
  }
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
