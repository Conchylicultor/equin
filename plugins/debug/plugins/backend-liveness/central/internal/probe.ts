import { access, readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/central";
import { GATEWAY_PORT } from "@plugins/infra/plugins/namespace/core";
import { PRINCIPAL_HEADER } from "@plugins/framework/plugins/principal/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  PROBE_EVERY_MS,
  PROBE_TIMEOUT_MS,
  humanMs,
  type BackendFrozenPayload,
} from "../../core";
import { createLivenessDetector, type Observation } from "./detect";

// The impure half of the liveness probe, on central: a process of its own, so
// it keeps observing while any backend's JS thread is frozen (every in-process
// detector froze with main on 2026-10-11). Each tick reads the gateway fleet,
// asks every backend for any HTTP answer on its own socket, and files what the
// pure detector returns through the report outbox — central has no reports
// table; main drains the outbox on the file change.

const GATEWAY_WORKTREES_URL = `http://localhost:${GATEWAY_PORT}/gateway/worktrees`;
/** Central itself: the observer cannot judge its own freeze. */
const SELF = "central";
/**
 * The gateway states with a backend process to judge. `starting` included: a
 * backend that froze before it became ready is just as frozen (it answers 503
 * while booting, nothing at all when frozen). `stopping` / `idle` are not.
 */
const PROBED_STATES = new Set(["starting", "running", "restarting"]);
/** A tick slower than this was suspended mid-probe (the machine slept). */
const SUSPENDED_TICK_MS = 3 * PROBE_TIMEOUT_MS;

const FleetSchema = z.array(
  z
    .object({ name: z.string(), state: z.string(), socketPath: z.string() })
    .passthrough(),
);
type Fleet = z.infer<typeof FleetSchema>;

// The gateway's pid sidecar next to every backend socket (gateway/worktree.go
// `backendSidecar`): which process serves it.
const SidecarSchema = z.object({ pid: z.number() }).passthrough();

const detector = createLivenessDetector();
let ticking = false;

export const livenessProbeTimer = defineTimer({
  name: "debug.backend-liveness-probe",
  description:
    "Asks every backend for any HTTP answer on its own socket and reports one that stays unanswered for a minute of awake time — from outside the backend, so a frozen JS thread is reported while it lasts.",
  everyMs: PROBE_EVERY_MS,
  unref: true,
  run: tick,
});

async function tick(): Promise<void> {
  // A tick outliving its period (the machine slept mid-tick) must not
  // interleave with the next: the detector's steps are ordered.
  if (ticking) return;
  ticking = true;
  try {
    const startedMs = Date.now();
    const fleet = await readFleet();
    if (!fleet.ok) {
      // The gateway restarting or down: nothing observed this tick, which the
      // detector records as such (the interval after it does not count).
      console.warn(
        `[backend-liveness] gateway fleet unreadable: ${fleet.error}`,
      );
      detector.step({ atMs: Date.now(), observations: null });
      return;
    }
    const observations = await observeFleet(fleet.fleet);
    const atMs = Date.now();
    const reports = detector.step({
      atMs,
      suspended: atMs - startedMs > SUSPENDED_TICK_MS,
      observations,
    });
    for (const r of reports) await file(r);
  } finally {
    ticking = false;
  }
}

async function readFleet(): Promise<
  { ok: true; fleet: Fleet } | { ok: false; error: string }
> {
  try {
    const res = await fetch(GATEWAY_WORKTREES_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `gateway responded ${res.status}` };
    return { ok: true, fleet: FleetSchema.parse(await res.json()) };
  } catch (err) {
    if (err instanceof z.ZodError) throw err; // the gateway's shape changed: loud
    return { ok: false, error: String(err) };
  }
}

async function observeFleet(fleet: Fleet): Promise<Observation[]> {
  const probed = fleet.filter(
    (w) => PROBED_STATES.has(w.state) && w.name !== SELF && w.socketPath !== "",
  );
  const observed = await Promise.all(
    probed.map((w) => observe(w.name, w.socketPath)),
  );
  return observed;
}

/** One backend's answer. */
async function observe(
  worktree: string,
  socketPath: string,
): Promise<Observation> {
  const pid = await readPid(socketPath);
  // No sidecar: the socket is mid-swap (a hot restart) or a legacy backend.
  // Not judged this tick rather than judged under a guessed identity (the
  // detector keeps the worktree's streak; -1 names no process).
  if (pid === null) return { worktree, pid: -1, result: "unknown" };
  const answer = await ask(socketPath);
  if (answer === "answered") return { worktree, pid, result: "answered" };
  const state = await processState(pid);
  if (state === "unknown") return { worktree, pid, result: "unknown" };
  if (state !== "running") return { worktree, pid, result: state };
  // A refused connect on a bound socket is a full accept backlog — a frozen
  // thread stops accepting — so only a missing socket means "not listening".
  if (answer === "unreachable" && !(await exists(socketPath)))
    return { worktree, pid, result: "unserved" };
  return { worktree, pid, result: "unanswered" };
}

async function readPid(socketPath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(`${socketPath}.pid`, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return SidecarSchema.parse(JSON.parse(raw)).pid;
}

/**
 * Whether the backend's JS thread answered: ANY HTTP response — 200, 503 while
 * booting, a refusal — is written by its JS, so it ran. Straight on the
 * socket, never through the gateway: the probe must neither cold-start a
 * backend nor count as activity that keeps it from its idle sweep.
 */
async function ask(
  socketPath: string,
): Promise<"answered" | "timeout" | "unreachable"> {
  try {
    const res = await fetch("http://backend/api/health/ready", {
      unix: socketPath,
      // A direct-socket call from a trusted local process, like the gateway's
      // own readiness probe.
      headers: { [PRINCIPAL_HEADER]: "owner" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return "answered";
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError")
      return "timeout";
    return "unreachable";
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    },
  );
}

/** Whether a process is running, stopped on purpose, or gone. */
async function processState(
  pid: number,
): Promise<"running" | "paused" | "exited" | "unknown"> {
  const result = await spawnCaptured(["ps", "-o", "stat=", "-p", String(pid)], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  // A host too loaded to run `ps` in time: no verdict this tick.
  if (result.timedOut) {
    console.warn(`[backend-liveness] ps -p ${pid} did not answer in ${PROBE_TIMEOUT_MS}ms`);
    return "unknown";
  }
  // `ps -p` exits 1 with no row for a pid that does not exist.
  const out = result.stdout.trim();
  // No row: gone. `Z`: exited, not yet reaped.
  if (out === "" || out.startsWith("Z")) return "exited";
  // `T`: stopped by a signal (SIGSTOP, a debugger) — paused on purpose.
  if (out.startsWith("T")) return "paused";
  return "running";
}

async function file(r: BackendFrozenPayload): Promise<void> {
  const unanswered = humanMs(r.unansweredMs);
  const message =
    r.state === "frozen"
      ? `${r.worktree} backend frozen — no answer for ${unanswered}`
      : `${r.worktree} backend was frozen ${unanswered}, then ${r.state}`;
  console.warn(`[backend-liveness] ${message} (pid ${r.pid})`);
  const result = await fileReportFromProcess({
    kind: "backend-frozen",
    message,
    data: r,
  });
  if (result.outcome !== "written")
    console.error(
      `[backend-liveness] could not file the report (${result.outcome}): ${message}`,
    );
}
