import { basename, dirname, sep } from "node:path";
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  pidAlive,
  readPidFile,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { PS } from "@plugins/infra/plugins/paths/server";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { killAgentPid } from "./agent-process";
import { agentPidsRoot } from "./paths";

// An agent process no pid file names is invisible to every backend: liveness,
// stop and every reaper go through the pid file (`agent-process.ts`), so once
// it is gone the process can never be commanded or killed again — it runs, with
// its Claude Code, until the machine reboots.
//
// It happens when the agent's exit stalls past the point where it removed its
// pid file: `shutdown` writes `exited`, closes its socket, and `process.exit`
// runs the `exit` listener that removes the pid file — then the process stayed
// (2026-10-20, and conv-1794147656-9o6et2 on 2026-11-08, found alive ten days
// later with its Claude Code child), its own hard exit never firing. The cause
// in Bun is not found; whatever it is, a stalled exit must not leak the
// process, so this sweep finds such agents from outside, by their argv, and
// kills them — and reports each, since every one is an exit that stalled.
//
// A schedule, not a watch: nothing signals that a process outlived its pid
// file. Main only (the default): the process table is machine-wide, and one
// sweeper is enough.

const log = Log.channel("runtime-sdk-orphan-agents");

/**
 * How old an agent process with no pid file must be before it is an orphan
 * rather than a start in progress: the agent writes its pid file once its
 * socket listens, which a launch waits for at most 60 s (`READY_TIMEOUT_MS`) —
 * a process ten times past that is no launch anyone still waits on.
 */
export const ORPHAN_MIN_AGE_MS = 10 * 60_000;

/** An agent process, as `ps` shows it. */
export interface AgentProcessLine {
  pid: number;
  ageMs: number;
  /** The namespace and conversation of the pid file its argv names. */
  namespace: string;
  conversationId: string;
}

/** `ps`'s `etime` — `[[dd-]hh:]mm:ss` — in milliseconds; null when it is not one. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (
    (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60 +
      Number(s)) *
    1000
  );
}

/**
 * The agent processes among `ps -axo pid=,etime=,command=` lines: those whose
 * argv names a pid file under `pidsRoot` (`--pid-file <root>/<ns>/<id>.pid`,
 * as `startAgentProcess` spells it) — only an agent's does.
 */
export function parseAgentProcesses(
  psOutput: string,
  pidsRoot: string,
): AgentProcessLine[] {
  const out: AgentProcessLine[] = [];
  const prefix = pidsRoot.endsWith(sep) ? pidsRoot : `${pidsRoot}${sep}`;
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const flag = /(?:^|\s)--pid-file\s+(\S+\.pid)(?=\s|$)/.exec(m[3]!);
    if (!flag) continue;
    const pidFile = flag[1]!;
    // `<root>/<ns>/<id>.pid`, exactly one level down.
    if (
      !pidFile.startsWith(prefix) ||
      dirname(dirname(pidFile)) + sep !== prefix
    )
      continue;
    const ageMs = parseEtime(m[2]!);
    if (ageMs === null) continue;
    out.push({
      pid: Number(m[1]),
      ageMs,
      namespace: basename(dirname(pidFile)),
      conversationId: basename(pidFile, ".pid"),
    });
  }
  return out;
}

/** What one agent process's pid file says of it. */
export type PidFileVerdict =
  | { kind: "named" }
  | { kind: "being-written" }
  | { kind: "orphan"; why: string };

/**
 * Whether `pid`'s pid file still names it. Absent, or naming another live
 * pid (a later start of the same conversation took the file over) — the
 * process is reachable by no one.
 */
export function pidFileVerdict(
  pid: number,
  read: Awaited<ReturnType<typeof readPidFile>>,
): PidFileVerdict {
  switch (read.kind) {
    case "absent":
      return { kind: "orphan", why: "its pid file is gone" };
    case "unreadable":
      return { kind: "being-written" };
    case "pid":
      return read.pid === pid
        ? { kind: "named" }
        : {
            kind: "orphan",
            why: `its pid file names pid ${String(read.pid)}${pidAlive(read.pid) ? "" : " (dead)"}`,
          };
  }
}

/** Every agent process on the machine (one `ps`). */
async function agentProcesses(): Promise<AgentProcessLine[]> {
  const ps = await spawnCaptured([PS, "-axo", "pid=,etime=,command="], {
    timeoutMs: 30_000,
  });
  if (ps.timedOut || ps.exitCode !== 0) {
    throw new Error(
      `ps failed (${ps.timedOut ? "timed out" : `exit ${String(ps.exitCode)}`}): ${ps.stderr.trim()}`,
    );
  }
  return parseAgentProcesses(ps.stdout, agentPidsRoot());
}

export interface OrphanSweep {
  agents: number;
  killed: number;
}

/** Kill every agent process older than {@link ORPHAN_MIN_AGE_MS} that no pid file names. */
export async function killOrphanAgents(): Promise<OrphanSweep> {
  const agents = await agentProcesses();
  let killed = 0;
  for (const agent of agents) {
    if (agent.ageMs < ORPHAN_MIN_AGE_MS) continue;
    const verdict = pidFileVerdict(
      agent.pid,
      await readPidFile(
        joinAppPath(
          agentPidsRoot(),
          agent.namespace,
          `${agent.conversationId}.pid`,
        ),
      ),
    );
    if (verdict.kind !== "orphan") continue;
    await killAgentPid(agent.pid);
    killed++;
    const { conversationId, namespace } = agent;
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agent ${conversationId} (namespace ${namespace}): killed pid ${String(agent.pid)} and its CLI, running ${String(Math.round(agent.ageMs / 60_000))} min while ${verdict.why} — no backend could reach it. An agent removes its pid file only as it exits, so its exit stalled after that (process.exit returned or hung, and its hard exit never ran)`,
      data: {
        errorType: "SdkAgentOrphaned",
        label: "runtime-sdk.orphan-agents",
      },
    });
  }
  return { agents: agents.length, killed };
}

export const orphanAgentsJob = defineJob({
  name: "runtime-sdk.orphan-agents",
  description:
    "Kills (and reports) every SDK agent process on the machine that no pid file names any more — an agent whose exit stalled after it removed its pid file, which no backend can see, stop or reap — together with its Claude Code.",
  // seconds: one `ps` and a pid-file read per agent process.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "23 * * * *" }, // hourly
  async run() {
    const r = await killOrphanAgents();
    if (r.killed > 0)
      log.publish(
        `killed ${String(r.killed)} orphaned agent process(es) of ${String(r.agents)}`,
      );
  },
});
