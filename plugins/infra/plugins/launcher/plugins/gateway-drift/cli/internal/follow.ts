import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  exists,
  readFile,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import { waitForFlock } from "@plugins/packages/plugins/flock/core";
import { heldDep, readyNow } from "@plugins/infra/plugins/deps/deps";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import { LEGACY_GATEWAY_PORT } from "@plugins/infra/plugins/namespace/core";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import {
  GatewayPortRecordSchema,
  type GatewayPortRecord,
} from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";
import {
  chooseGatewayPort,
  describeChoice,
  probeGateway,
  writeGatewayPortRecord,
} from "@plugins/infra/plugins/launcher/plugins/gateway-port/machine";
import { readGatewayPortRecordSync } from "@plugins/infra/plugins/launcher/plugins/gateway-port/data-dirs";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  GATEWAY_APP_COMPONENT,
  gatewayBinary,
  gatewayBuild,
} from "@plugins/infra/plugins/launcher/deps";
import {
  awaitGatewayReady,
  gatewayLaunchSpec,
  gatewayServiceJob,
  handOverGateway,
} from "@plugins/infra/plugins/launcher/server";
import {
  awaitProcessGone,
  installServiceExecutable,
  loginService,
  machineMacosAppHost,
  reloadService,
  type LoginService,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";
import {
  compareGatewayLaunch,
  dialAddressOf,
  flagValue,
  listenPortOf,
} from "../../machine";
import {
  describeGatewayRestartFailed,
  errorLines,
  type GatewayRestartFailedPayload,
} from "../../core";
import {
  FOLLOW_LOCK_FILENAME,
  gatewayFollowState,
  LAST_ATTEMPT_FILENAME,
  SWITCH_LOG_FILENAME,
  SWITCH_PLAN_FILENAME,
} from "../../data-dirs";
import {
  adoptGatewayLaunch,
  holdGatewayBuild,
  MACHINE_GATEWAY_HOLDER,
  prepareMainGateway,
} from "./main-gateway";

/** What {@link followMainGateway} did. */
export type GatewayFollowOutcome =
  | { kind: "not-applicable"; reason: string }
  | { kind: "current" }
  | { kind: "already-attempted"; at: string; outcome: AttemptOutcome }
  | {
      kind: "restarted";
      pid: number;
      remaining: string[];
      /** handover: no backend stopped (a restart is a `switching`). */
      via: "handover";
    }
  | {
      /**
       * The service restart (a changed listen set, a gateway with no keeper)
       * was handed to the switch helper, which outlives this run: its outcome
       * is in its log, a failure filed as a report.
       */
      kind: "switching";
      helperPid: number;
    }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; rolledBack: boolean };

type AttemptOutcome = "started" | "restarted" | "refused" | "failed";

/** The launch last tried, so a launch is tried once (see {@link followMainGateway}). */
const LastAttemptSchema = z.object({
  key: z.string(),
  at: z.string(),
  outcome: z.enum(["started", "restarted", "refused", "failed"]),
});
type LastAttempt = z.infer<typeof LastAttemptSchema>;

/**
 * Bring the machine's gateway onto main's — main's convergence run calls this
 * after its builds (`./equin build --allow-main --converge`), so a push that
 * changes what the gateway runs (its Go source, its flags, the declared
 * environment names, its cwd) takes effect with no one running `./equin start
 * --force`.
 *
 * - **Only main's checkout, only the machine's gateway.** It acts when this
 *   checkout is the one the installed gateway deploys (`-main-checkout`), and
 *   the gateway is a login service `start` registered
 *   (`compareGatewayLaunch` — the health row's own comparison — else
 *   not-applicable).
 * - **When stale only.** It builds main's gateway (`prepareMainGateway`, a hash
 *   when unchanged), then compares; current is a no-op.
 * - **One launch, tried once.** The launch's key (build, argv, cwd, env names)
 *   is recorded before anything is touched, and a key already recorded is not
 *   tried again, whatever its outcome — every gateway boot starts a converge
 *   run, so a gateway that cannot come up would otherwise be retried by its
 *   own rollback's boot, forever. The next launch main changes is the next try.
 * - **Never no gateway.** The previous launch is captured first — the job
 *   definition verbatim (a new job may carry a flag the old binary rejects)
 *   and the build the `machine-gateway` holder keeps (what the old job runs;
 *   the hold moves only once the new gateway answers). No held build means no
 *   way back: it refuses rather than gamble. A new gateway that does not
 *   listen (`awaitGatewayReady`: dead, or not listening in 120 s) is replaced
 *   by the previous one — reinstalled, its definition restored, reloaded and
 *   awaited.
 * - **Loud.** A refusal or a failure is filed as a `gateway-restart-failed`
 *   report through the outbox — the gateway that started this run is the one
 *   it replaced, so a non-zero exit would reach no one — and the health row
 *   stays Out of date.
 *
 * A machine-wide flock serializes it: the replaced gateway's successor starts
 * a converge run at its boot, which must wait for this one to finish (and then
 * finds the gateway current, or the launch already attempted).
 */
export async function followMainGateway(opts: {
  /** The checkout this convergence run deploys. */
  checkout: string;
  log: (line: string) => void;
}): Promise<GatewayFollowOutcome> {
  const { log } = opts;
  return withGatewayFollowLock(() => followLocked(opts.checkout, log));
}

/**
 * Run `fn` holding the machine-wide gateway-follow lock: one swap of the
 * machine's gateway at a time — main's follow step, the successor's boot-edge
 * run, and a person's `./equin start` (which takes it around its own reload).
 */
export async function withGatewayFollowLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(gatewayFollowState.path, { recursive: true });
  const lock = await waitForFlock(
    gatewayFollowState.file(FOLLOW_LOCK_FILENAME),
  );
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function followLocked(
  checkout: string,
  log: (line: string) => void,
): Promise<GatewayFollowOutcome> {
  const before = await compareGatewayLaunch();
  if (before.kind === "not-applicable") {
    return { kind: "not-applicable", reason: before.reason };
  }
  const deploys = flagOf(before.installed.argv, "-main-checkout");
  if (deploys === undefined || !(await samePath(deploys, checkout))) {
    return {
      kind: "not-applicable",
      reason: `the machine's gateway deploys ${deploys ?? "nothing"}, not ${checkout}`,
    };
  }
  const { service } = before;

  // The port: the account's, once recorded. An install still on 9000 with
  // none recorded is moved — the first free one of 8700…8709, recorded only
  // once the gateway answers there (by the switch helper), 9000 kept as the
  // legacy listener so bookmarks, open tabs and running agents follow.
  const installedPort = listenPortOf(before.installed.argv.slice(1));
  const portRead = readGatewayPortRecordSync();
  let portMove: GatewayPortRecord | null = null;
  let port: number;
  let legacyPort: number | null;
  if (portRead.kind === "set") {
    port = portRead.record.port;
    legacyPort = portRead.record.legacy;
  } else if (installedPort === LEGACY_GATEWAY_PORT) {
    const choice = await chooseGatewayPort();
    log(
      `gateway: moving off port ${LEGACY_GATEWAY_PORT} — ${describeChoice(choice)}`,
    );
    port = choice.port;
    legacyPort = LEGACY_GATEWAY_PORT;
    portMove = { port, legacy: LEGACY_GATEWAY_PORT };
  } else {
    // No record, and a job on another port: a move that wrote its job but
    // never recorded its port — the helper died, or the machine went down,
    // before the new gateway answered. The job's own ports are the move's.
    port = installedPort;
    const installedLegacy = flagValue(
      before.installed.argv.slice(1),
      "-legacy-listen",
    );
    legacyPort = installedLegacy === undefined ? null : LEGACY_GATEWAY_PORT;
    portMove = {
      port,
      legacy: installedLegacy === undefined ? null : LEGACY_GATEWAY_PORT,
    };
    // Already answering there (a login started the written job): record it
    // now, which is all the move had left to do.
    if ((await probeGateway(port)).kind === "ours") {
      await writeGatewayPortRecord(portMove);
      log(`gateway: recorded port ${port}, which a move had left unrecorded`);
    }
  }

  const app = machineMacosAppHost({ exec: cliExecContext() }, log);
  const prepared = await prepareMainGateway({
    logLevel: before.logLevel,
    port,
    legacyPort,
    app,
    log,
  });
  // Again, now that main's binary is built: before, a new identity read as
  // "not built yet".
  const drift = await compareGatewayLaunch();
  if (drift.kind === "not-applicable") {
    return { kind: "not-applicable", reason: drift.reason };
  }
  // The whole job too: the drift row cannot rebuild the environment (it is
  // the starter's), but this run starts from the gateway's own declared
  // environment, so a job that differs only there (the PATH rule) is a launch
  // main changed.
  const job = gatewayServiceJob(gatewayLaunchSpec(prepared.launch));
  const differences = [...drift.differences];
  if (differences.length === 0 && !(await service.isCurrent(job))) {
    differences.push("the job's declared environment changed");
  }
  if (differences.length === 0) return { kind: "current" };

  const to = prepared.launch.executable.identity;
  const key = launchKey(job, to);
  const last = await readLastAttempt();
  if (last !== null && last.key === key) {
    log(
      `gateway: this launch was already attempted at ${last.at} (${last.outcome}); not retried — still out of date: ${differences.join("; ")}`,
    );
    return { kind: "already-attempted", at: last.at, outcome: last.outcome };
  }
  log(`gateway: out of date — ${differences.join("; ")}`);

  // The way back, captured before anything is touched.
  const definition = await service.readDefinition();
  const held = await heldDep(gatewayBinary, MACHINE_GATEWAY_HOLDER);
  const from = held.kind === "held" ? gatewayBuild(held.ready).identity : null;
  await recordAttempt(key, "started");
  const report = (
    stage: GatewayRestartFailedPayload["stage"],
    error: string[],
    rollback: GatewayRestartFailedPayload["rollback"],
  ) =>
    fileFailure({
      to,
      from,
      differences,
      stage,
      error,
      rollback,
      checkout,
      at: Date.now(),
    });

  if (definition === null || held.kind === "none") {
    const reason =
      definition === null
        ? "the gateway's job definition could not be read back"
        : `no gateway build is held as ${MACHINE_GATEWAY_HOLDER}, so the running gateway could not be reinstalled if main's failed`;
    log(`gateway: NOT restarting — ${reason}`);
    await recordAttempt(key, "refused");
    await report("refused", [reason], { kind: "not-needed" });
    return { kind: "refused", reason };
  }

  const state = await service.state();
  const runningPid = state.kind === "loaded" ? state.pid : null;
  const installedFlags = before.installed.argv.slice(1);
  try {
    const launch = await adoptGatewayLaunch(prepared, app, log);
    const spec = gatewayLaunchSpec(launch);
    await service.write(gatewayServiceJob(spec));
    const switchPlan: GatewaySwitchPlan = {
      key,
      to,
      from,
      differences,
      checkout,
      definition,
      newPort: launch.port,
      oldPort: listenPortOf(installedFlags),
      record: portMove,
      runPid: process.pid,
      stdioLog: spec.stdioLog,
    };
    // A changed listen set cannot be handed over: the keeper holds the
    // sockets, and a generation refuses a -listen it does not hold. That is a
    // restart of the service — done by the switch helper (below).
    if (listenSetOf(installedFlags) !== listenSetOf(spec.argv.slice(1))) {
      log(
        `gateway: its listen addresses change (${listenSetOf(installedFlags)} → ${listenSetOf(spec.argv.slice(1))}); restarting the service onto ${to}`,
      );
      const pid = await startGatewaySwitch(switchPlan, log);
      return { kind: "switching", helperPid: pid };
    }
    // A handover first: the keeper replaces the gateway process over the
    // same listening sockets and the same backends — no request refused, no
    // backend stopped (gateway/CLAUDE.md, "The gateway follows main"). The
    // written job is what the NEXT start of the service (a login, a
    // keeper restart) runs.
    const [binary = "", ...args] = spec.argv;
    log(`gateway: handing over onto ${to}`);
    const handed = await handOverGateway({
      dialAddress: dialAddressOf(installedFlags),
      launch: { binary, args, env: spec.env, dir: spec.cwd },
    });
    switch (handed.kind) {
      case "handed-over":
        log(
          `gateway: handed over in ${handed.tookMs} ms (gateway PID ${handed.pid}); no backend restarted`,
        );
        break;
      case "failed":
        // The running gateway keeps serving: only the files are put back.
        throw new Error(
          `the handover failed; the running gateway keeps serving: ${handed.reason}`,
        );
      case "no-keeper": {
        // A gateway from before the keeper: restart its service (every
        // backend stops with it), once — the new one runs under a keeper.
        log(
          `gateway: the running gateway predates handovers; restarting (PID ${runningPid ?? "none"}) onto ${to}`,
        );
        const pid = await startGatewaySwitch(switchPlan, log);
        return { kind: "switching", helperPid: pid };
      }
    }
    // The new gateway answers: from here nothing rolls it back. A failure in
    // the bookkeeping below throws (the run's log has it) but leaves it serving.
    await recordAttempt(key, "restarted");
    await holdGatewayBuild(prepared.gateway);
    const after = await compareGatewayLaunch();
    const remaining = after.kind === "compared" ? after.differences : [];
    log(
      `gateway: handed over onto ${to} (PID ${handed.pid})${remaining.length > 0 ? ` — a restart does not fix: ${remaining.join("; ")}` : ""}`,
    );
    return { kind: "restarted", pid: handed.pid, remaining, via: "handover" };
  } catch (err) {
    log(`gateway: main's gateway did not come up: ${String(err)}`);
    const error = errorLines(err);
    const rollback = await restorePrevious({
      service,
      definition,
      previous: held.ready,
      app,
      reload: false,
      port: listenPortOf(installedFlags),
      log,
    });
    await recordAttempt(key, "failed");
    await report("failed", error, rollback);
    return { kind: "failed", rolledBack: rollback.kind === "restored" };
  }
}

/**
 * The listen addresses a launch names (`-listen`, `-legacy-listen`), as one
 * comparable string: what the keeper holds, which a handover cannot change.
 * A launch without `-listen` is from before it was required — its default.
 */
function listenSetOf(flags: readonly string[]): string {
  return `${flagValue(flags, "-listen") ?? `loopback:${LEGACY_GATEWAY_PORT}`} ${flagValue(flags, "-legacy-listen") ?? "-"}`;
}

/**
 * Everything the switch helper needs to restart the gateway's service onto a
 * written job, and to put the previous one back: handed over as a file, since
 * the helper is a process of its own.
 */
const GatewaySwitchPlanSchema = z.object({
  key: z.string(),
  to: z.string(),
  from: z.string().nullable(),
  differences: z.array(z.string()),
  checkout: z.string(),
  /** The previous job definition, verbatim. */
  definition: z.string(),
  /** Where the new gateway listens, and the old one did. */
  newPort: z.number().int(),
  oldPort: z.number().int(),
  /** The port record to write once the new gateway answers — set by a move to a new port, else null. */
  record: GatewayPortRecordSchema.nullable(),
  /** The deploy run that planned it: the helper restarts nothing until it has exited. */
  runPid: z.number().int(),
  stdioLog: z.string(),
});
type GatewaySwitchPlan = z.infer<typeof GatewaySwitchPlanSchema>;

/**
 * Hand the restart of the gateway's service to the switch helper
 * (`gateway-drift/bin/switch.ts`), detached into a session of its own, and
 * return its pid.
 *
 * Not done in this process: this run is main's deploy run, a child the KEEPER
 * spawned, and unloading the service stops the keeper — which signals every
 * child's whole process group (`stopChildren`, gateway/keeper.go). This run
 * would die between the unload and the load, with nothing left to load the
 * new job or put the old one back: no gateway until the next login. The
 * helper is in neither the keeper's child table nor this run's process group
 * (its own session, `setsid`), and launchd's bootout ends only the job's
 * group, so it outlives the stop it causes. It waits for this run's follow
 * lock first, so it starts once this follow returned.
 */
async function startGatewaySwitch(
  plan: GatewaySwitchPlan,
  log: (line: string) => void,
): Promise<number> {
  await mkdir(gatewayFollowState.path, { recursive: true });
  await writeFile(
    gatewayFollowState.file(SWITCH_PLAN_FILENAME),
    `${JSON.stringify(plan)}\n`,
  );
  const out = await openOwnedFd(
    gatewayFollowState.file(SWITCH_LOG_FILENAME),
    "a",
  );
  const child = spawn(
    process.execPath,
    [SWITCH_HELPER, gatewayFollowState.file(SWITCH_PLAN_FILENAME)],
    { detached: true, stdio: ["ignore", out.fd, out.fd], cwd: plan.checkout },
  );
  out.close();
  child.unref();
  if (child.pid === undefined) {
    throw new Error("the gateway switch helper did not start");
  }
  log(
    `gateway: the service restart runs in a helper of its own (PID ${child.pid}), so it outlives this run; its log: ${gatewayFollowState.file(SWITCH_LOG_FILENAME)}`,
  );
  return child.pid;
}

/**
 * How long the helper waits for the deploy run to exit: the follow is that
 * run's last step, so it ends within seconds; past this, something holds it
 * and the restart is not safe to start.
 */
const RUN_EXIT_BUDGET_MS = 5 * 60_000;

/** The switch helper's entry point (a `bin/` of this plugin). */
const SWITCH_HELPER = fileURLToPath(
  new URL("../../bin/switch.ts", import.meta.url),
);

/**
 * The switch helper's work (`bin/switch.ts`): restart the gateway's service
 * onto the job the follow wrote, await it on its new port, then record the
 * port (a move off 9000) and the outcome — or put the previous gateway back,
 * awaited on its old port, and file the failure. Under the follow lock, so it
 * starts once the follow that planned it returned.
 */
export async function completeGatewaySwitch(
  planFile: string,
  log: (line: string) => void,
): Promise<void> {
  const plan = GatewaySwitchPlanSchema.parse(
    JSON.parse(await readFile(planFile, "utf-8")),
  );
  await withGatewayFollowLock(async () => {
    // Nothing is unloaded yet: a failure here leaves the old gateway serving,
    // and the job the follow wrote is put back where it can be.
    const service = await loginService(GATEWAY_SERVICE);
    const held = await heldDep(gatewayBinary, MACHINE_GATEWAY_HOLDER);
    if (service === null || held.kind !== "held") {
      const reason =
        service === null
          ? "this machine has no service manager for the gateway"
          : `no gateway build is held as ${MACHINE_GATEWAY_HOLDER}`;
      if (service !== null) await service.restoreDefinition(plan.definition);
      await recordAttempt(plan.key, "failed");
      await fileFailure({
        to: plan.to,
        from: plan.from,
        differences: plan.differences,
        stage: "failed",
        error: [reason],
        rollback:
          service === null
            ? { kind: "failed", error: [reason] }
            : { kind: "restored", pid: null },
        checkout: plan.checkout,
        at: Date.now(),
      });
      throw new Error(reason);
    }
    const app = machineMacosAppHost({ exec: cliExecContext() }, log);
    const report = (
      error: string[],
      rollback: GatewayRestartFailedPayload["rollback"],
    ) =>
      fileFailure({
        to: plan.to,
        from: plan.from,
        differences: plan.differences,
        stage: "failed",
        error,
        rollback,
        checkout: plan.checkout,
        at: Date.now(),
      });
    let unloaded = false;
    let pid: number;
    try {
      // The run that planned this must be gone first: it is a child the
      // keeper spawned, and the stop below would kill it mid-exit.
      log(`gateway: waiting for the deploy run (PID ${plan.runPid}) to end`);
      await awaitProcessGone(plan.runPid, RUN_EXIT_BUDGET_MS);
      const state = await service.state();
      const runningPid = state.kind === "loaded" ? state.pid : null;
      log(
        `gateway: restarting the service (PID ${runningPid ?? "none"}) onto ${plan.to}, port ${plan.oldPort} → ${plan.newPort}`,
      );
      unloaded = true;
      const loaded = await reloadService(service, runningPid, () =>
        writeFile(plan.stdioLog, ""),
      );
      if (loaded === null) {
        throw new Error(`${service.id.label} loaded with no running process`);
      }
      await awaitGatewayReady({ pid: loaded, port: plan.newPort });
      pid = loaded;
    } catch (err) {
      log(`gateway: main's gateway did not come up: ${String(err)}`);
      const rollback = await restorePrevious({
        service,
        definition: plan.definition,
        previous: held.ready,
        app,
        reload: unloaded,
        port: plan.oldPort,
        log,
      });
      await recordAttempt(plan.key, "failed");
      await report(errorLines(err), rollback);
      return;
    }
    // It answers on its port: only now is the port this account's.
    if (plan.record !== null) {
      await writeGatewayPortRecord(plan.record);
      log(
        `gateway: this account's port is now ${plan.record.port}${plan.record.legacy === null ? "" : ` (${plan.record.legacy} keeps answering and redirects pages to it)`}`,
      );
    }
    await recordAttempt(plan.key, "restarted");
    const ready = await heldOrBuilt(plan.to);
    if (ready !== null) await holdGatewayBuild(ready);
    log(`gateway: restarted onto ${plan.to} (PID ${pid})`);
  });
}

/** Main's gateway build of identity `to`, to hold once it runs. */
async function heldOrBuilt(to: string) {
  const repoRoot = await getMainRepoRoot();
  const now = await readyNow(gatewayBinary, { root: repoRoot });
  return now.kind === "ready" && gatewayBuild(now.ready).identity === to
    ? now.ready
    : null;
}

/**
 * Put the previous gateway back: its build into the bundle (macOS), its job
 * definition byte for byte, and — when the swap had already unloaded it — a
 * reload awaited like any start. Before the unload the old gateway still runs,
 * so only the files are restored (a later relaunch must run the old launch,
 * not half of the new one).
 */
async function restorePrevious(opts: {
  service: LoginService;
  definition: string;
  previous: Parameters<typeof gatewayBuild>[0];
  app: ReturnType<typeof machineMacosAppHost>;
  reload: boolean;
  /** The port the previous gateway listens on, to await it there. */
  port: number;
  log: (line: string) => void;
}): Promise<GatewayRestartFailedPayload["rollback"]> {
  const { service, log } = opts;
  try {
    await installServiceExecutable(
      opts.app,
      GATEWAY_APP_COMPONENT,
      gatewayBuild(opts.previous),
      log,
    );
    await opts.service.restoreDefinition(opts.definition);
    if (!opts.reload) {
      log("gateway: the previous gateway kept running; its launch is restored");
      const state = await service.state();
      return {
        kind: "restored",
        pid: state.kind === "loaded" ? state.pid : null,
      };
    }
    const state = await service.state();
    const pid =
      state.kind === "loaded"
        ? await reloadService(service, state.pid, () => {})
        : await service.load();
    if (pid === null) {
      throw new Error(`${service.id.label} loaded with no running process`);
    }
    await awaitGatewayReady({ pid, port: opts.port });
    log(`gateway: rolled back — the previous gateway runs again (PID ${pid})`);
    return { kind: "restored", pid };
  } catch (err) {
    log(`gateway: ROLLBACK FAILED: ${String(err)}`);
    return { kind: "failed", error: errorLines(err) };
  }
}

/** `-flag value` in an argv, or undefined. */
function flagOf(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * One launch's key: the build, argv (binary path and every flag), cwd and the
 * environment's NAMES — never its values. A value this run inherits that
 * differed from run to run would otherwise mint a new key on every gateway
 * boot, and each boot's run would restart the gateway again: the loop the key
 * exists to end. So an environment-value change is tried once per launch.
 */
function launchKey(
  job: ReturnType<typeof gatewayServiceJob>,
  identity: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        identity,
        argv: job.argv,
        cwd: job.cwd,
        env: Object.keys(job.env).sort(),
      }),
    )
    .digest("hex");
}

/** Whether two paths name the same directory (symlinks resolved). */
async function samePath(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  if (!(await exists(a)) || !(await exists(b))) return false;
  return (await realpath(a)) === (await realpath(b));
}

type LastAttemptRead = LastAttempt | null;

async function readLastAttempt(): Promise<LastAttemptRead> {
  const path = gatewayFollowState.file(LAST_ATTEMPT_FILENAME);
  if (!(await exists(path))) return null;
  return LastAttemptSchema.parse(JSON.parse(await readFile(path, "utf-8")));
}

async function recordAttempt(key: string, outcome: AttemptOutcome) {
  const attempt: LastAttempt = { key, at: new Date().toISOString(), outcome };
  await writeFile(
    gatewayFollowState.file(LAST_ATTEMPT_FILENAME),
    `${JSON.stringify(attempt)}\n`,
  );
}

async function fileFailure(payload: GatewayRestartFailedPayload) {
  const filed = await fileReportFromProcess({
    kind: "gateway-restart-failed",
    message: describeGatewayRestartFailed(payload),
    data: payload,
  });
  if (filed.outcome !== "written") {
    // fileReportFromProcess already printed why; the run's log keeps it.
    console.error(
      `gateway: the gateway-restart-failed report was not filed (${filed.outcome})`,
    );
  }
}
