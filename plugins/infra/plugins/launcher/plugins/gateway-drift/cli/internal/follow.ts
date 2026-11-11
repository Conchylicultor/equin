import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  exists,
  readFile,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import { waitForFlock } from "@plugins/packages/plugins/flock/core";
import { heldDep } from "@plugins/infra/plugins/deps/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  GATEWAY_APP_COMPONENT,
  gatewayBinary,
  gatewayBuild,
} from "@plugins/infra/plugins/launcher/deps";
import {
  awaitGatewayReady,
  DEV_GATEWAY_PORT,
  gatewayLaunchSpec,
  gatewayServiceJob,
} from "@plugins/infra/plugins/launcher/server";
import {
  installServiceExecutable,
  machineMacosAppHost,
  reloadService,
  type LoginService,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import { compareGatewayLaunch } from "../../machine";
import {
  describeGatewayRestartFailed,
  errorLines,
  type GatewayRestartFailedPayload,
} from "../../core";
import {
  FOLLOW_LOCK_FILENAME,
  gatewayFollowState,
  LAST_ATTEMPT_FILENAME,
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
  | { kind: "restarted"; pid: number; remaining: string[] }
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

  const app = machineMacosAppHost({ exec: cliExecContext() }, log);
  const prepared = await prepareMainGateway({
    logLevel: before.logLevel,
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
  let unloaded = false;
  let newPid: number;
  try {
    const launch = await adoptGatewayLaunch(prepared, app, log);
    const spec = gatewayLaunchSpec(launch);
    await service.write(gatewayServiceJob(spec));
    log(`gateway: restarting (PID ${runningPid ?? "none"}) onto ${to}`);
    unloaded = true;
    const pid = await reloadService(service, runningPid, () =>
      writeFile(spec.stdioLog, ""),
    );
    if (pid === null) {
      throw new Error(`${service.id.label} loaded with no running process`);
    }
    await awaitGatewayReady({ pid, port: DEV_GATEWAY_PORT });
    newPid = pid;
  } catch (err) {
    log(`gateway: main's gateway did not come up: ${String(err)}`);
    const error = errorLines(err);
    const rollback = await restorePrevious({
      service,
      definition,
      previous: held.ready,
      app,
      reload: unloaded,
      log,
    });
    await recordAttempt(key, "failed");
    await report("failed", error, rollback);
    return { kind: "failed", rolledBack: rollback.kind === "restored" };
  }
  // The new gateway answers: from here nothing rolls it back. A failure in the
  // bookkeeping below throws (the run's log has it) but leaves it serving.
  await recordAttempt(key, "restarted");
  await holdGatewayBuild(prepared.gateway);
  const after = await compareGatewayLaunch();
  const remaining = after.kind === "compared" ? after.differences : [];
  log(
    `gateway: restarted onto ${to} (PID ${newPid})${remaining.length > 0 ? ` — a restart does not fix: ${remaining.join("; ")}` : ""}`,
  );
  return { kind: "restarted", pid: newPid, remaining };
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
    await awaitGatewayReady({ pid, port: DEV_GATEWAY_PORT });
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
