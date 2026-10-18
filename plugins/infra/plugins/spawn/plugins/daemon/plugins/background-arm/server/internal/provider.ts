import type {
  BackgroundEntryDraft,
  BackgroundFact,
} from "@plugins/infra/plugins/background/plugins/catalog/core";
import { defineBackgroundKind } from "@plugins/infra/plugins/background/plugins/catalog/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  backoffPolicy,
  daemonRecentRuns,
  listDaemons,
  type DaemonInstanceInfo,
  type DaemonSnapshot,
  type DaemonState,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";

/** At most this many instances are listed one per fact; the rest are counted. */
const RUNNING_FACTS_MAX = 10;
/** `ps` is a wedge-breaker bound, not latency police (see infra/spawn). */
const PS_TIMEOUT_MS = 5_000;

const STATE_WORDS: Record<DaemonState, string> = {
  starting: "starting",
  running: "running",
  respawning: "respawning",
  "gave-up": "gave up",
  exited: "exited",
};

/** Memory and CPU per pid, from one `ps` over every pid listed. */
type Usage =
  | {
      kind: "read";
      byPid: Map<number, { rssMb: number; cpu: number; uptime: string }>;
    }
  | { kind: "unavailable"; why: string };

async function readUsage(pids: number[]): Promise<Usage> {
  if (pids.length === 0) return { kind: "read", byPid: new Map() };
  const res = await spawnCaptured(
    ["ps", "-o", "pid=,rss=,%cpu=,etime=", "-p", pids.join(",")],
    { timeoutMs: PS_TIMEOUT_MS },
  );
  if (res.timedOut) {
    return {
      kind: "unavailable",
      why: `ps timed out after ${PS_TIMEOUT_MS} ms`,
    };
  }
  // ps exits 1 when ANY listed pid is gone; the rows of the others are still
  // printed, so the output is the answer either way.
  const byPid = new Map<
    number,
    { rssMb: number; cpu: number; uptime: string }
  >();
  for (const line of res.stdout.split("\n")) {
    const [pid, rss, cpu, etime] = line.trim().split(/\s+/);
    if (
      pid === undefined ||
      rss === undefined ||
      cpu === undefined ||
      etime === undefined
    )
      continue;
    byPid.set(Number(pid), {
      rssMb: Number(rss) / 1024,
      cpu: Number(cpu),
      uptime: etime,
    });
  }
  return { kind: "read", byPid };
}

function clock(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function day(d: Date): string {
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? clock(d)
    : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${clock(d)}`;
}

/** The OS process an instance's numbers come from. */
function usagePid(i: DaemonInstanceInfo): number | null {
  return i.arm === "worker" ? process.pid : i.pid;
}

function usageWords(i: DaemonInstanceInfo, usage: Usage): string | null {
  const pid = usagePid(i);
  if (pid === null || i.state !== "running") return null;
  if (usage.kind === "unavailable") return `memory unknown (${usage.why})`;
  const u = usage.byPid.get(pid);
  if (u === undefined) return "memory unknown (not in ps)";
  if (i.arm === "worker") {
    return `${Math.round(u.rssMb)} MB · ${u.cpu.toFixed(1)}% CPU (the whole backend)`;
  }
  // ps's own uptime ([[dd-]hh:]mm:ss): the process's real age, which for an
  // attached or detached process predates this backend seeing it.
  return `up ${u.uptime} · ${Math.round(u.rssMb)} MB · ${u.cpu.toFixed(1)}% CPU`;
}

function instanceWords(i: DaemonInstanceInfo, usage: Usage): string {
  const parts: string[] = [];
  if (i.instance !== null) parts.push(i.instance);
  parts.push(STATE_WORDS[i.state]);
  if (i.arm === "worker") parts.push(`thread in backend pid ${process.pid}`);
  else if (i.pid !== null) parts.push(`pid ${i.pid}`);
  // An attached / detached process was only SEEN at this time — its real age
  // is ps's uptime below.
  const seen = i.arm === "attached" || i.arm === "detached";
  parts.push(
    `${seen ? "seen since" : "since"} ${day(i.spawnedAt ?? i.startedAt)}`,
  );
  if (i.restarts > 0)
    parts.push(`${i.restarts} ${i.restarts === 1 ? "restart" : "restarts"}`);
  const u = usageWords(i, usage);
  if (u !== null) parts.push(u);
  return parts.join(" · ");
}

function policyWords(d: DaemonSnapshot): string {
  const p = backoffPolicy(d.restart);
  if (p === null) return "Never — an exit is final until its owner restarts it";
  const healthy =
    p.healthy === "ready"
      ? "healthy once it signals ready"
      : `healthy once it outlives ${p.rapidExitMs / 1000} s`;
  return `Backoff ${p.minMs / 1000}–${p.maxMs / 1000} s; gives up after ${p.maxRapidFailures} exits within ${p.rapidExitMs / 1000} s of spawn; ${healthy}`;
}

/** How liveness is known — a property of how its instances were started, so
 * `null` while there are none. */
function livenessWords(d: DaemonSnapshot): string | null {
  if (d.instances.length === 0) return null;
  const files = d.instances.filter((i) => i.pidFile !== null);
  if (files.length > 0) {
    return `Pid file${files.length > 1 ? "s" : ""} ${files.map((i) => i.pidFile).join(", ")} — checked when this list loads`;
  }
  return "Exit event — known the moment it ends";
}

function facts(d: DaemonSnapshot, usage: Usage): BackgroundFact[] {
  const out: BackgroundFact[] = [
    {
      label: "Instances",
      value:
        d.instances.length > 0 || d.runsHere
          ? String(d.instances.length)
          : "0 — runs on main only",
    },
  ];
  for (const i of d.instances.slice(0, RUNNING_FACTS_MAX)) {
    out.push({ label: "Instance", value: instanceWords(i, usage) });
  }
  if (d.instances.length > RUNNING_FACTS_MAX) {
    out.push({
      label: "Instance",
      value: `…and ${d.instances.length - RUNNING_FACTS_MAX} more`,
    });
  }
  const exits = d.instances
    .flatMap((i) =>
      i.lastExit === null ? [] : [{ instance: i.instance, ...i.lastExit }],
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const last = exits[0];
  if (last !== undefined) {
    out.push({
      label: "Last exit",
      value: `${last.instance === null ? "" : `${last.instance}: `}${last.reason} · ${day(last.at)}`,
    });
  }
  out.push({ label: "Restart policy", value: policyWords(d) });
  const liveness = livenessWords(d);
  if (liveness !== null) out.push({ label: "Liveness", value: liveness });
  out.push({
    label: "Runs in",
    value: "This process, in memory — history resets when it restarts",
  });
  return out;
}

/** Every declared daemon as a catalog entry. */
export async function listDaemonEntries(): Promise<BackgroundEntryDraft[]> {
  const daemons = listDaemons();
  const pids = new Set<number>();
  for (const d of daemons) {
    for (const i of d.instances) {
      const pid = usagePid(i);
      if (pid !== null && i.state === "running") pids.add(pid);
    }
  }
  const usage = await readUsage([...pids]);
  return daemons.map((d) => ({
    name: d.name,
    description: d.description,
    group: "Long-lived processes",
    trigger: d.startedBy === "boot" ? { kind: "boot" } : { kind: "on-demand" },
    scope: d.scope,
    runsHere: d.runsHere,
    declaredIn: d.declaredIn,
    lastRun: d.recentRuns[0] ?? null,
    history: {
      runs: d.runs,
      failures: d.failures,
      lastSuccessAt: d.lastSuccessAt?.toISOString() ?? null,
    },
    canRunNow: false,
    internal: false,
    facts: facts(d, usage),
  }));
}

export const daemonsBackgroundKind = defineBackgroundKind({
  kind: "daemon",
  order: 40,
  label: "Long-lived processes",
  // Daemon state is the process registry and `ps`, never Postgres.
  tables: [],
  list: listDaemonEntries,
  recentRuns: daemonRecentRuns,
});
