import { writeFileSync } from "node:fs";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { assertPrerequisites } from "@plugins/framework/plugins/cli/plugins/doctor/cli";
import { installLockedToolchain } from "@plugins/infra/plugins/deps/plugins/mise/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  adoptGatewayLaunch,
  holdGatewayBuild,
  prepareMainGateway,
  withGatewayFollowLock,
  type PreparedGateway,
} from "@plugins/infra/plugins/launcher/plugins/gateway-drift/cli";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import {
  assertSupportedHost,
  readPid,
  isRunning,
  isGatewayListening,
  spawnGatewayDaemon,
  gatewayLaunchSpec,
  awaitGatewayReady,
  DEV_GATEWAY_PORT,
  gatewayServiceJob,
  type GatewayLaunchOptions,
} from "@plugins/infra/plugins/launcher/server";
import {
  declaredLoginServices,
  loginServiceManager,
  machineMacosAppHost,
  reconcileLoginService,
  reloadService,
  terminateProcess,
  type LoginService,
  type LoginServiceDeclaration,
  type LoginServiceManager,
  type MacosAppHost,
  type ReconcileOutcome,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";

type Opts = { force?: boolean; logLevel: string; only?: string };

const run: CliAction<[], Opts> = async (opts) => {
  // `--only` is resolved first: a typo fails before anything is installed,
  // built or restarted.
  const declared = await declaredLoginServices();
  const manager = loginServiceManager();
  // The label the gateway's service is bound to on this machine — the old one
  // until `./equin data-dir migrate` relabels it (`installedAs`).
  const gatewayService = manager
    ? await manager.service(GATEWAY_SERVICE)
    : null;
  const gatewayLabel = gatewayService?.id.label ?? GATEWAY_SERVICE.label;
  const selected = selectServices(opts.only, gatewayLabel, declared);
  // The releases mise.lock records, installed if a lock arrived without them
  // (a clone, a pull, an upstream merge) — before the doctor, which would
  // otherwise only report them missing.
  const installed = await installLockedToolchain(await getWorktreeRoot());
  if (installed.length > 0)
    console.log(`Installed the locked toolchain: ${installed.join(", ")}`);
  // Every missing dev prerequisite at once, before the gateway compile.
  await assertPrerequisites();
  // Same host preconditions as a release launch: the dev gateway supervises
  // the same embedded cluster, so the same machine facts have to hold.
  assertSupportedHost();

  // The equin app bundle every service runs from on macOS (a no-op elsewhere).
  const app = machineMacosAppHost({ exec: cliExecContext() }, console.log);
  if (selected(gatewayLabel)) {
    // Under the lock main's follow-main step swaps the gateway with, so a
    // person's start never interleaves with an automatic restart.
    await withGatewayFollowLock(() =>
      gatewayService
        ? startAsLoginService(gatewayService, opts, app)
        : startDetached(opts, app),
    );
  }
  // Then every login service a plugin declares — none named here.
  await startDeclaredLoginServices(
    manager,
    declared.filter((d) => selected(d.id)),
    opts,
    app,
  );
};

/**
 * `--only <ids>`: which services this `start` touches — the gateway by its
 * label, a declared one by its id; every one without the flag. An unknown id
 * throws, listing the known ones. With `--force` it is the per-service
 * restart (`--only dev.equin.menu-bar --force` leaves the gateway, and so every
 * backend, alone).
 */
function selectServices(
  only: string | undefined,
  gatewayLabel: string,
  declared: readonly LoginServiceDeclaration[],
): (id: string) => boolean {
  if (only === undefined) return () => true;
  const known = [gatewayLabel, ...declared.map((d) => d.id)];
  const ids = only
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const unknown = ids.filter((id) => !known.includes(id));
  if (ids.length === 0 || unknown.length > 0) {
    throw new Error(
      `--only ${JSON.stringify(only)}: ${ids.length === 0 ? "names no service" : `unknown service${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`}. Known: ${known.join(", ")}.`,
    );
  }
  const picked = new Set(ids);
  return (id) => picked.has(id);
}

/**
 * The gateway is a per-user OS service (a launchd LaunchAgent on macOS, a
 * systemd user unit on Linux), so it comes back after a reboot and is
 * relaunched if it dies. The manager owns the process; this command (re)writes
 * the job, (re)loads it, and waits for it to serve.
 */
async function startAsLoginService(
  loginService: LoginService,
  opts: Opts,
  app: MacosAppHost,
): Promise<void> {
  const manager = loginService.manager;
  const service = await loginService.state();
  const managedPid = service.kind === "loaded" ? service.pid : null;
  const pidfilePid = await readPid();
  // A gateway the manager does not own: started by a `start` from before the
  // gateway was a service.
  const legacyPid =
    pidfilePid !== null && pidfilePid !== managedPid && isRunning(pidfilePid)
      ? pidfilePid
      : null;

  if (managedPid !== null && !opts.force) {
    printRunning(
      `Gateway is already running under ${manager} (PID ${managedPid})`,
    );
    await reportStaleGateway(loginService, opts, app);
    return;
  }
  if (
    managedPid === null &&
    legacyPid === null &&
    (await isGatewayListening(DEV_GATEWAY_PORT))
  ) {
    printRunning(
      "Gateway is already running on port 9000 (started externally).",
    );
    return;
  }

  const prepared = await prepareGateway(opts, app);
  const launch = await adoptAndHold(prepared, app);
  const spec = gatewayLaunchSpec(launch);
  const written = await loginService.write(gatewayServiceJob(spec));
  console.log(
    `Registered ${loginService.id.label} with ${manager} (${written.path})`,
  );

  if (legacyPid !== null) {
    if (!opts.force) {
      // Registering is enough for the next login/boot; swapping the live
      // gateway restarts every backend, which only an explicit --force asks for.
      console.log(
        `The running gateway (PID ${legacyPid}) was started before it was a ${manager} service. It keeps running now, and ${manager} starts it from the next ${loginService.startsAt} on. Run \`./equin start --only ${loginService.id.label} --force\` to hand it to ${manager} now.`,
      );
      return;
    }
    console.log(
      `Stopping the gateway started outside ${manager} (PID ${legacyPid})...`,
    );
    await terminateProcess(legacyPid);
  }

  // The manager appends; truncate so the tail quoted on a failed start is this boot's.
  const truncateLog = () => writeFileSync(spec.stdioLog, "");
  let pid: number | null;
  if (service.kind === "loaded") {
    // Unload rather than restart in place: neither manager re-reads a job
    // definition while it is loaded, so a rewritten job takes effect only
    // through a reload — one that always loads once it has unloaded.
    console.log(`Reloading the ${manager} job...`);
    pid = await reloadService(loginService, managedPid, truncateLog);
  } else {
    truncateLog();
    pid = await loginService.load();
  }
  // The gateway's service id carries no schedule: it always runs.
  if (pid === null)
    throw new Error(`${loginService.id.label} loaded with no running process`);
  await awaitGatewayReady({ pid, port: DEV_GATEWAY_PORT });
  printRunning(
    `Gateway started under ${manager} (PID ${pid}); it starts again at every ${loginService.startsAt}`,
  );
}

/**
 * Main's gateway job, built but not applied: the running gateway keeps its
 * binary — swapping it restarts every backend, which only an explicit
 * `--force` asks for — but a stale one is said, with the command that swaps
 * it. The definition is not rewritten and the hold not moved, so the job keeps
 * naming the binary that runs, and the deps sweep keeps off it.
 */
async function reportStaleGateway(
  loginService: LoginService,
  opts: Opts,
  app: MacosAppHost,
): Promise<void> {
  const { gateway, launch } = await prepareGateway(opts, app);
  if (
    await loginService.isCurrent(gatewayServiceJob(gatewayLaunchSpec(launch)))
  )
    return;
  console.log(
    `  Stale:   the gateway's job changed since the running gateway started (main's gateway binary is now ${gateway.dir}, identity ${gateway.identity}). It keeps running the old one; \`./equin start --only ${loginService.id.label} --force\` swaps it (restarts every backend).`,
  );
}

/**
 * Every login service a plugin declares (`login-services/index.ts`, collected
 * by `infra/launcher/login-services`) that `--only` selects, after the gateway:
 * each one's dependency ensured from the MAIN checkout — a CLI may build in the
 * foreground — then reconciled (`reconcileLoginService`, the body main's boot
 * shares): held, its job (re)written, and (re)loaded when it is not running,
 * its job changed, or `--force`.
 */
async function startDeclaredLoginServices(
  manager: LoginServiceManager | null,
  declared: readonly LoginServiceDeclaration[],
  opts: Opts,
  app: MacosAppHost,
): Promise<void> {
  if (declared.length === 0) return;
  if (manager === null) {
    console.log(
      `Not starting ${declared.map((d) => d.id).join(", ")}: this OS has no service manager to run them.`,
    );
    return;
  }
  const root = await getMainRepoRoot();
  for (const decl of declared) {
    const ready = await ensureDep(decl.dep, cliExecContext(), {
      root,
      log: console.log,
    });
    const { service, outcome } = await reconcileLoginService(
      manager,
      decl,
      ready,
      opts.force ? "force" : "start",
      { host: app, log: console.log },
    );
    console.log(
      `${decl.id} (${decl.owner}) ${describeStart(outcome, service)}`,
    );
  }
}

function describeStart(
  outcome: ReconcileOutcome,
  service: LoginService,
): string {
  switch (outcome.kind) {
    case "unchanged":
      return service.id.schedule === undefined
        ? `is already running under ${service.manager} (PID ${outcome.pid ?? "none"})`
        : `is already scheduled under ${service.manager} (every ${service.id.schedule.everySeconds} s)`;
    case "started":
      return service.id.schedule === undefined
        ? `${outcome.reloaded ? "restarted" : "started"} under ${service.manager} (PID ${outcome.pid ?? "none"}); it starts again at every ${service.startsAt} (${outcome.path})`
        : `${outcome.reloaded ? "rescheduled" : "scheduled"} under ${service.manager}: runs every ${service.id.schedule.everySeconds} s, from every ${service.startsAt} on (${outcome.path})`;
    // Only `follow` stops short of loading.
    case "unregistered":
    case "rewritten":
      throw new Error(
        `reconcileLoginService answered ${outcome.kind} to ./equin start`,
      );
  }
}

/**
 * Hosts without a service manager: the detached spawn. It does not survive a reboot —
 * run `./equin start` again after one.
 */
async function startDetached(opts: Opts, app: MacosAppHost): Promise<void> {
  const existingPid = await readPid();
  const pidAlive = existingPid !== null && isRunning(existingPid);

  if (!pidAlive && (await isGatewayListening(DEV_GATEWAY_PORT))) {
    printRunning(
      "Gateway is already running on port 9000 (started externally).",
    );
    return;
  }

  if (pidAlive) {
    if (!opts.force) {
      printRunning(`Gateway is already running (PID ${existingPid})`);
      return;
    }
    console.log(`Stopping existing gateway (PID ${existingPid})...`);
    await terminateProcess(existingPid!);
  }

  const launch = await adoptAndHold(await prepareGateway(opts, app), app);
  // `.pid` only, and no `.ref()`: the gateway deliberately outlives `start`.
  const { pid } = await spawnGatewayDaemon(launch);

  // Wait for the gateway to actually serve before claiming success. It exits
  // when a managed service fails to start, so printing unconditionally
  // reported success for an already-dead gateway.
  await awaitGatewayReady({ pid, port: DEV_GATEWAY_PORT });
  printRunning(`Gateway started (PID ${pid})`);
  console.log(
    "  Not registered with a service manager on this OS: run `./equin start` again after a reboot.",
  );
}

/** Main's gateway build and the launch that would run it (`gateway-drift/cli`). */
function prepareGateway(
  opts: Opts,
  app: MacosAppHost,
): Promise<PreparedGateway> {
  return prepareMainGateway({ logLevel: opts.logLevel, app, log: console.log });
}

/**
 * Apply a prepared launch and hold its build: `start` has no way back to
 * offer (a person runs it, and reads its failure), so the hold moves at once —
 * unlike main's follow-main restart, which holds only once the new gateway
 * answers.
 */
async function adoptAndHold(
  prepared: PreparedGateway,
  app: MacosAppHost,
): Promise<GatewayLaunchOptions> {
  const launch = await adoptGatewayLaunch(prepared, app, console.log);
  await holdGatewayBuild(prepared.gateway);
  return launch;
}

function printRunning(headline: string): void {
  console.log(headline);
  console.log(`  Logs:    ${gatewayLogs.path}/`);
  console.log(`  Gateway: ${namespaceUrl(MAIN_WORKTREE_NAME)}`);
}

export default run;
