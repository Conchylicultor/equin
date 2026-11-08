import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, writeFile } from "node:fs/promises";
import { exists } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import {
  holdDep,
  type DepSource,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import {
  loginServiceHolder,
  loginServiceId,
  loginServiceJob,
  referredLabels,
  type LoginServiceDeclaration,
} from "./define";
import type { LoginService, LoginServiceManager } from "./login-service";
import { installServiceExecutable, type MacosAppHost } from "./macos-app";
import { SERVICE_STOP_WAIT_MS } from "../../core";
import { awaitProcessGone } from "./process";

/**
 * How far a reconcile may go with a declared service:
 *
 * - `start` — `./equin start`: load it when it is not running, reload it when
 *   its job changed.
 * - `force` — `./equin start --force`: always (re)load it.
 * - `follow` — main's boot: only a service that is registered AND loaded is
 *   reloaded, and only when its job changed. Registered but not loaded (a
 *   `stop`) gets its definition rewritten, never loaded — it comes up on the
 *   next login with main's binary. Unregistered (never `start`ed, or
 *   `stop --disable`) is not touched: `start` is the opt-in.
 */
export type ReconcilePolicy = "start" | "force" | "follow";

export type ReconcileOutcome =
  /** No definition, under `follow`: nothing held, written or loaded. */
  | { kind: "unregistered" }
  /** The definition already named this job and nothing asked for a reload. */
  | { kind: "unchanged"; pid: number | null }
  /** The definition was updated but not loaded (`follow`, service stopped). */
  | { kind: "rewritten"; path: string }
  /**
   * Loaded — `reloaded` when a running generation was unloaded first. `pid`
   * is null for a periodic service between its runs.
   */
  | { kind: "started"; pid: number | null; path: string; reloaded: boolean };

/** What a reconcile did, and the service it did it to (as bound by the manager). */
export interface Reconciled {
  service: LoginService;
  outcome: ReconcileOutcome;
}

/**
 * Bring one declared login service to `ready`'s job under `policy`: bind it
 * and every service it refers to under `manager`, hold the dependency (off
 * macOS the job names its binary by path long after main moves on), install
 * its executable into the equin app (macOS), write the job, and (re)load it
 * when the policy says so. The one per-service body shared by `./equin start`
 * and main's boot (`follow-main.ts`), so the two cannot disagree on what
 * "changed" means, on the unload → gone → load order, or on which labels the
 * job names.
 */
export async function reconcileLoginService<S extends DepSource>(
  manager: LoginServiceManager,
  decl: LoginServiceDeclaration<S>,
  ready: Ready<S>,
  policy: ReconcilePolicy,
  app: { host: MacosAppHost; log: (line: string) => void },
): Promise<Reconciled> {
  const service = await manager.service(loginServiceId(decl));
  return {
    service,
    outcome: await reconcileBound(manager, service, decl, ready, policy, app),
  };
}

async function reconcileBound<S extends DepSource>(
  manager: LoginServiceManager,
  service: LoginService,
  decl: LoginServiceDeclaration<S>,
  ready: Ready<S>,
  policy: ReconcilePolicy,
  app: { host: MacosAppHost; log: (line: string) => void },
): Promise<ReconcileOutcome> {
  // Decided before holding or writing anything: following main must never
  // register a service the user did not `start`.
  if (policy === "follow" && !(await exists(service.definitionPath())))
    return { kind: "unregistered" };

  await holdDep(ready, loginServiceHolder(decl));
  const before = await service.state();
  // Swapped in under a running generation, which keeps its own executable
  // until the reload below (measured: its grants hold meanwhile).
  const executable = await installServiceExecutable(
    app.host,
    decl.executable,
    decl.executable.build(ready),
    app.log,
  );
  const job = loginServiceJob(
    decl,
    ready,
    executable,
    await referredLabels(manager, decl),
  );
  const written = await service.write(job);
  const runningPid = before.kind === "loaded" ? before.pid : null;
  // An always-running service runs while it has a pid; a periodic one while
  // the manager holds it (it has a pid only mid-run).
  const running =
    service.id.schedule === undefined
      ? runningPid !== null
      : before.kind === "loaded";

  if (policy === "follow") {
    if (before.kind !== "loaded")
      return written.changed
        ? { kind: "rewritten", path: written.path }
        : { kind: "unchanged", pid: null };
    if (!written.changed) return { kind: "unchanged", pid: runningPid };
  } else if (policy === "start" && running && !written.changed) {
    return { kind: "unchanged", pid: runningPid };
  }

  // The manager appends; truncate so the log holds this start's output. Its
  // folder may not exist yet (a declaration's first start), and neither
  // launchd nor systemd creates it — the job would fail to spawn.
  const truncateLog = async () => {
    await mkdir(asAppPath(dirname(job.stdioLog)), { recursive: true });
    await writeFile(job.stdioLog, "");
  };
  // Neither manager re-reads a loaded job: a rewritten one takes effect only
  // through a reload.
  let pid: number | null;
  if (before.kind === "loaded") {
    pid = await reloadService(service, runningPid, truncateLog);
  } else {
    await truncateLog();
    pid = await service.load();
  }
  return {
    kind: "started",
    pid,
    path: written.path,
    reloaded: before.kind === "loaded",
  };
}

/**
 * Swap a loaded service for its written job: unload it, wait for the running
 * generation (`runningPid`) to be gone, run `beforeLoad` (skipped when the wait
 * gave up), load. The one reload
 * body — `reconcileLoginService` and the gateway's `./equin start --force`
 * both go through it.
 *
 * **Once `unload` has run, the load is always attempted.** The unload has
 * already taken the service down, so a reload that stops there leaves the
 * machine without it — for the gateway, without every backend and every tab
 * (2026-11-08: the wait gave up, the command aborted, no gateway for minutes).
 * So a wait that gives up does not skip the load; it is reported with it:
 *
 * - The load succeeds → the old process is gone after all: the manager runs
 *   one instance of a job and refuses to load it while the old one is still
 *   being stopped (launchd's bootstrap fails with EIO), so a load that went
 *   through is itself the proof. No overlap of generations is possible.
 * - The load fails → both errors are thrown together: the old process
 *   survived its manager's SIGKILL (a process stuck in the kernel) and the
 *   manager will not start a second one. Nothing here can fix that; it is
 *   said, not hidden.
 *
 * Resolves with the loaded pid ({@link LoginService.load}). `stopWaitMs`
 * bounds the wait (default: past the manager's own kill).
 */
export async function reloadService(
  service: LoginService,
  runningPid: number | null,
  beforeLoad: () => Promise<void> | void,
  stopWaitMs: number = SERVICE_STOP_WAIT_MS,
): Promise<number | null> {
  await service.unload();
  let notGone: unknown = null;
  if (runningPid !== null) {
    try {
      await awaitProcessGone(runningPid, stopWaitMs);
    } catch (err) {
      notGone = err;
    }
  }
  // A process that outlived its stop keeps its output: beforeLoad truncates
  // the stdio log, which is then the one record of what it was stuck in.
  if (notGone === null) await beforeLoad();
  try {
    return await service.load();
  } catch (loadErr) {
    if (notGone === null) throw loadErr;
    throw new AggregateError(
      [notGone, loadErr],
      `${service.id.label}: the old process (PID ${runningPid}) outlived its stop and ${service.manager} would not load the new one: ${String(loadErr)}`,
    );
  }
}
