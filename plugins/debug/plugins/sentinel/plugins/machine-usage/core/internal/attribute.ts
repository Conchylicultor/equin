import {
  MACHINE_USAGE_BUCKETS,
  type MachineUsageBucket,
  type MachineUsageGroup,
} from "./machine-usage";

/** One line of `ps -A -o pid=,ppid=,%cpu=,rss=,args=`. */
export interface PsProcess {
  pid: number;
  ppid: number;
  /** `ps` %cpu: 100 = one core. */
  cpu: number;
  rssBytes: number;
  args: string;
}

/** The `-o` list `parsePs` reads. */
export const PS_COLUMNS = "pid=,ppid=,%cpu=,rss=,args=";

const LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;

export function parsePs(stdout: string): PsProcess[] {
  const procs: PsProcess[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`[machine-usage] unexpected ps line: ${line}`);
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

/** The processes a bucket owns along with every descendant. */
export interface UsageRoots {
  /** The agent browser host, when one runs. */
  agentBrowser: number | null;
  /** Every running op's CLI process. */
  agentOps: readonly number[];
}

/**
 * Google Chrome's main process and every helper (renderer, GPU, utility) live
 * inside its app bundle, so the executable path names them all. The agent
 * browser's Chromium (Playwright's build) and a Chrome an e2e run launched are
 * claimed by their roots first.
 */
const CHROME_BUNDLE = "/Google Chrome.app/";

/**
 * Which bucket each process belongs to: a descendant of the agent browser
 * host, then of a running op, then Chrome's bundle, else other. A root's
 * subtree is claimed whole, so a process another root already claimed (an
 * op's Chromium under the browser host cannot happen, but precedence is
 * explicit) keeps its first owner.
 */
export function attributeProcesses(
  procs: readonly PsProcess[],
  roots: UsageRoots,
): Map<number, MachineUsageBucket> {
  const children = new Map<number, PsProcess[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const owner = new Map<number, MachineUsageBucket>();
  const claim = (root: number, bucket: MachineUsageBucket): void => {
    const stack = [root];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (owner.has(pid)) continue;
      owner.set(pid, bucket);
      for (const c of children.get(pid) ?? []) stack.push(c.pid);
    }
  };
  const listed = new Set(procs.map((p) => p.pid));
  if (roots.agentBrowser !== null && listed.has(roots.agentBrowser)) {
    claim(roots.agentBrowser, "agent-browser");
  }
  for (const pid of roots.agentOps) {
    if (listed.has(pid)) claim(pid, "agent-ops");
  }
  for (const p of procs) {
    if (owner.has(p.pid)) continue;
    owner.set(p.pid, p.args.includes(CHROME_BUNDLE) ? "chrome" : "other");
  }
  return owner;
}

/** Each bucket's totals, in `MACHINE_USAGE_BUCKETS` order (an empty one too). */
export function sumByBucket(
  procs: readonly PsProcess[],
  owner: ReadonlyMap<number, MachineUsageBucket>,
  memBytesOf: (p: PsProcess) => number,
): MachineUsageGroup[] {
  const groups = new Map<MachineUsageBucket, MachineUsageGroup>(
    MACHINE_USAGE_BUCKETS.map((bucket) => [
      bucket,
      { bucket, processes: 0, cpuPercent: 0, memBytes: 0 },
    ]),
  );
  for (const p of procs) {
    const g = groups.get(owner.get(p.pid) ?? "other")!;
    g.processes++;
    g.cpuPercent += p.cpu;
    g.memBytes += memBytesOf(p);
  }
  return [...groups.values()];
}
