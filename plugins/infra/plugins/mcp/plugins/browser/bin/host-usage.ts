import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import type {
  AgentBrowserProcessRole,
  AgentBrowserUsage,
  AgentBrowserUsageGroup,
} from "../core";

/**
 * What the host and its Chromium cost the machine right now: one `ps` over
 * every process, kept to this host's own tree (itself, Chromium's browser
 * process, and the GPU / renderer / utility processes under it), grouped by
 * Chromium's `--type=`. `%cpu` is the kernel's recent decaying average, so a
 * single read answers "now" without sampling twice.
 *
 * Per tab is not offered: Chromium shares renderers between same-site tabs and
 * draws every tab's frames in the one GPU process, so no number here belongs
 * to one tab. A tab's state (rendering or frozen) is in the status instead.
 */

const PS_MS = 5_000;

interface Proc {
  pid: number;
  ppid: number;
  cpu: number;
  rssBytes: number;
  args: string;
}

const LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;

function parsePs(stdout: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`[agent-browser] unexpected ps line: ${line}`);
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssBytes: Number(m[4]) * 1024,
      args: m[5] ?? "",
    });
  }
  return procs;
}

function roleOf(p: Proc, hostPid: number): AgentBrowserProcessRole {
  if (p.pid === hostPid) return "host";
  const type = /--type=([\w-]+)/.exec(p.args)?.[1];
  if (type === undefined) return "browser";
  if (type === "gpu-process") return "gpu";
  if (type === "renderer") return "renderer";
  if (type === "utility") return "utility";
  return "other";
}

export async function sampleUsage(): Promise<AgentBrowserUsage> {
  const hostPid = process.pid;
  const { stdout } = await spawnExpectOk(
    ["ps", "-A", "-o", "pid=,ppid=,%cpu=,rss=,args="],
    { timeoutMs: PS_MS },
  );
  const procs = parsePs(stdout);
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const groups = new Map<AgentBrowserProcessRole, AgentBrowserUsageGroup>();
  const visit = (p: Proc): void => {
    const role = roleOf(p, hostPid);
    const g = groups.get(role);
    if (g) {
      g.processes++;
      g.cpuPercent += p.cpu;
      g.rssBytes += p.rssBytes;
    } else {
      groups.set(role, {
        role,
        processes: 1,
        cpuPercent: p.cpu,
        rssBytes: p.rssBytes,
      });
    }
    for (const c of children.get(p.pid) ?? []) visit(c);
  };
  const self = procs.find((p) => p.pid === hostPid);
  if (!self)
    throw new Error(
      `[agent-browser] ps does not list the host (pid ${hostPid})`,
    );
  visit(self);
  return {
    kind: "sampled",
    at: new Date().toISOString(),
    pid: hostPid,
    groups: [...groups.values()].sort((a, b) => b.cpuPercent - a.cpuPercent),
  };
}
