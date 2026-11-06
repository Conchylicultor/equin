import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { processKindOf } from "@plugins/packages/plugins/process-name/core";
import {
  MACHINE_USAGE_BUCKETS,
  type MachineUsageBucket,
  type MachineUsageGroup,
} from "./machine-usage";

/** One line of `ps -A -o pid=,ppid=,%cpu=,rss=,time=,args=`. */
export interface PsProcess {
  pid: number;
  ppid: number;
  /** `ps` %cpu: 100 = one core, the kernel's recent decaying average. */
  cpu: number;
  rssBytes: number;
  /** Cumulative CPU time (user + system) since the process started, ms. */
  cpuTimeMs: number;
  /**
   * CPU time of every child this process reaped (and the grandchildren they
   * reaped), ms — read from the kernel per process, where it answers (this
   * account's processes); absent where it does not. `ps` has no column for it.
   */
  reapedChildrenMs?: number;
  args: string;
}

/** The `-o` list `parsePs` reads. */
export const PS_COLUMNS = "pid=,ppid=,%cpu=,rss=,time=,args=";

const LINE =
  /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+(?:\.\d+)?)\s+(.*)$/;

/** `ps`'s `time`: `[[dd-]hh:]mm:ss.cc` (macOS prints unbounded minutes). */
function parseCpuTime(text: string): number {
  const [days, rest] = text.includes("-")
    ? [Number(text.split("-")[0]), text.split("-")[1]!]
    : [0, text];
  const parts = rest.split(":").map(Number);
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return Math.round((days * 86_400 + seconds) * 1000);
}

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
      cpuTimeMs: parseCpuTime(m[5]!),
      args: m[6] ?? "",
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

/** The app's own bundle: the gateway (and the native helper beside it). */
const APP_BUNDLE = `/${PRODUCT_NAME}.app/`;

/** The executable's file name: the command line up to its first space. */
function executableName(args: string): string {
  const exe = args.split(" ", 1)[0] ?? "";
  return exe.slice(exe.lastIndexOf("/") + 1);
}

/**
 * The bucket a process heads by what it runs — the names the build and the
 * agent runtime give their processes (packages/process-name), the app bundle,
 * Postgres's binaries — or null. Its whole subtree goes with it.
 */
function namedRootBucket(args: string): MachineUsageBucket | null {
  const exe = executableName(args);
  if (exe === "postgres" || exe === "pgbouncer") return "postgres";
  if (args.includes(APP_BUNDLE)) return "backends";
  const kind = processKindOf(args);
  if (kind === "server" || kind === "central") return "backends";
  // The SDK agent wrapper, and its Claude Code (named for its conversation),
  // when found without the wrapper above it.
  if (kind === "agent" || kind?.startsWith("conv-")) return "agents";
  return null;
}

/**
 * Which bucket each process belongs to. Roots claim their whole subtree, in
 * precedence order: the agent browser host, then each running op (so an
 * agent's build is the op's, not the agent's), then each process heading a
 * bucket by its name (Postgres, a backend, an agent). The rest is Chrome by
 * its bundle, else other. A process another root already claimed keeps its
 * first owner.
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
    const bucket = namedRootBucket(p.args);
    if (bucket !== null) claim(p.pid, bucket);
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
