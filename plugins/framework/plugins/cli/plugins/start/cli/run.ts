import { writeFileSync } from "node:fs";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { assertPrerequisites } from "@plugins/framework/plugins/cli/plugins/doctor/cli";
import { installLockedToolchain } from "@plugins/infra/plugins/deps/plugins/mise/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import { ensureDep, holdDep } from "@plugins/infra/plugins/deps/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  GATEWAY_APP_COMPONENT,
  gatewayBinary,
  gatewayBuild,
} from "@plugins/infra/plugins/launcher/deps";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/data-dirs";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import {
  assertSupportedHost,
  readPid,
  isRunning,
  isGatewayListening,
  ensureDatabaseConfig,
  spawnGatewayDaemon,
  gatewayLaunchSpec,
  awaitGatewayReady,
  LISTEN_ENV,
  DEV_GATEWAY_PORT,
  devGatewayLaunchOptions,
  GATEWAY_SERVICE,
  gatewayServiceJob,
  type GatewayLaunchOptions,
} from "@plugins/infra/plugins/launcher/server";
import {
  awaitProcessGone,
  declaredLoginServices,
  installServiceExecutable,
  loginServiceId,
  loginServiceManager,
  machineMacosAppHost,
  plannedServiceExecutable,
  reconcileLoginService,
  terminateProcess,
  type LoginService,
  type LoginServiceDeclaration,
  type LoginServiceManager,
  type MacosAppHost,
  type ReconcileOutcome,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import type { Ready } from "@plugins/infra/plugins/deps/deps";
import type { BuildSource } from "@plugins/infra/plugins/deps/plugins/build/deps";

type Opts = { force?: boolean; logLevel: string; only?: string };

const run: CliAction<[], Opts> = async (opts) => {
  // `--only` is resolved first: a typo fails before anything is installed,
  // built or restarted.
  const declared = await declaredLoginServices();
  const selected = selectServices(opts.only, declared);
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

  const manager = loginServiceManager();
  // The equin app bundle every service runs from on macOS (a no-op elsewhere).
  const app = machineMacosAppHost({ exec: cliExecContext() }, console.log);
  if (selected(GATEWAY_SERVICE.label)) {
    if (manager)
      await startAsLoginService(manager.service(GATEWAY_SERVICE), opts, app);
    else await startDetached(opts, app);
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
  declared: readonly LoginServiceDeclaration[],
): (id: string) => boolean {
  if (only === undefined) return () => true;
  const known = [GATEWAY_SERVICE.label, ...declared.map((d) => d.id)];
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
  const pidfilePid = readPid();
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
  const launch = await adoptGatewayLaunch(prepared, app);
  const spec = gatewayLaunchSpec(launch);
  const written = loginService.write(gatewayServiceJob(spec));
  console.log(
    `Registered ${GATEWAY_SERVICE.label} with ${manager} (${written.path})`,
  );

  if (legacyPid !== null) {
    if (!opts.force) {
      // Registering is enough for the next login/boot; swapping the live
      // gateway restarts every backend, which only an explicit --force asks for.
      console.log(
        `The running gateway (PID ${legacyPid}) was started before it was a ${manager} service. It keeps running now, and ${manager} starts it from the next ${loginService.startsAt} on. Run \`./equin start --only ${GATEWAY_SERVICE.label} --force\` to hand it to ${manager} now.`,
      );
      return;
    }
    console.log(
      `Stopping the gateway started outside ${manager} (PID ${legacyPid})...`,
    );
    await terminateProcess(legacyPid);
  }

  if (service.kind === "loaded") {
    // Unload rather than restart in place: neither manager re-reads a job
    // definition while it is loaded, so a rewritten job takes effect only
    // through a reload.
    console.log(`Reloading the ${manager} job...`);
    await loginService.unload();
    if (managedPid !== null) await awaitProcessGone(managedPid);
  }

  // The manager appends; truncate so the tail quoted on a failed start is this boot's.
  writeFileSync(spec.stdioLog, "");
  const pid = await loginService.load();
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
  if (loginService.isCurrent(gatewayServiceJob(gatewayLaunchSpec(launch))))
    return;
  console.log(
    `  Stale:   the gateway's job changed since the running gateway started (main's gateway binary is now ${gateway.dir}, identity ${gateway.identity}). It keeps running the old one; \`./equin start --only ${GATEWAY_SERVICE.label} --force\` swaps it (restarts every backend).`,
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
    const service = manager.service(loginServiceId(decl));
    const outcome = await reconcileLoginService(
      service,
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
      return `is already running under ${service.manager} (PID ${outcome.pid ?? "none"})`;
    case "started":
      return `${outcome.reloaded ? "restarted" : "started"} under ${service.manager} (PID ${outcome.pid}); it starts again at every ${service.startsAt} (${outcome.path})`;
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
  const existingPid = readPid();
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

  const launch = await adoptGatewayLaunch(await prepareGateway(opts, app), app);
  // `.pid` only, and no `.ref()`: the gateway deliberately outlives `start`.
  const { pid } = spawnGatewayDaemon(launch);

  // Wait for the gateway to actually serve before claiming success. It exits
  // when a managed service fails to start, so printing unconditionally
  // reported success for an already-dead gateway.
  await awaitGatewayReady({ pid, port: DEV_GATEWAY_PORT });
  printRunning(`Gateway started (PID ${pid})`);
  console.log(
    "  Not registered with a service manager on this OS: run `./equin start` again after a reboot.",
  );
}

/** Main's gateway build, and the launch that would run it — nothing applied yet. */
interface PreparedGateway {
  gateway: Ready<BuildSource>;
  launch: GatewayLaunchOptions;
}

/**
 * Ensure main's gateway binary and derive the launch options — every input to
 * a launch, nothing applied yet: the executable is where the build WOULD run
 * (inside the equin app bundle on macOS), not installed there. Built only when
 * main's gateway source (or Go) changed since the last build (the identity is
 * the source hash), so an unchanged one costs a hash. It does not reach a
 * RUNNING gateway: `start` without `--force` leaves that one on its binary and
 * only reports it stale (`reportStaleGateway`); a launch applies the options
 * first (`adoptGatewayLaunch`).
 */
async function prepareGateway(
  opts: Opts,
  app: MacosAppHost,
): Promise<PreparedGateway> {
  // The machine's gateway is MAIN's: built from the main checkout's Go source
  // whichever checkout runs `start`.
  const repoRoot = await getMainRepoRoot();
  const gateway = await ensureDep(gatewayBinary, cliExecContext(), {
    root: repoRoot,
    log: console.log,
  });
  console.log(`Gateway binary: ${gateway.dir} (${gateway.identity})`);
  return {
    gateway,
    launch: {
      executable: plannedServiceExecutable(
        app,
        GATEWAY_APP_COMPONENT,
        gatewayBuild(gateway),
      ),
      ...devGatewayLaunchOptions({ repoRoot, logLevel: opts.logLevel }),
    },
  };
}

/**
 * Apply a prepared launch before it runs: the binary installed into the equin
 * app bundle (macOS; re-signed there when this machine's identity changed),
 * the build held, `database.json` written. Only on the paths that launch —
 * swapping the bundle's gateway or moving the hold off the build the running
 * gateway runs is not a staleness report's to do, and the running gateway's
 * config is not this command's to change under it.
 */
async function adoptGatewayLaunch(
  { gateway, launch }: PreparedGateway,
  app: MacosAppHost,
): Promise<GatewayLaunchOptions> {
  const executable = await installServiceExecutable(
    app,
    GATEWAY_APP_COMPONENT,
    gatewayBuild(gateway),
    console.log,
  );
  // Off macOS the service job (and a detached gateway) names this binary by
  // path long after main's source moves on: keep the deps sweep off it until
  // the next `start` moves the hold to a newer build. (On macOS the bundle is
  // a copy; the hold only keeps the build it was made from.)
  holdDep(gateway, "machine-gateway");
  ensureDatabaseConfig(launch.cwd, console.log);
  console.log(
    launch.bindHost === null
      ? `Binding the gateway to every interface (${LISTEN_ENV}=:${DEV_GATEWAY_PORT})`
      : `Binding the gateway to ${launch.bindHost}:${DEV_GATEWAY_PORT}`,
  );
  return { ...launch, executable };
}

function printRunning(headline: string): void {
  console.log(headline);
  console.log(`  Logs:    ${gatewayLogs.path}/`);
  console.log(`  Gateway: ${namespaceUrl(MAIN_WORKTREE_NAME)}`);
}

export default run;
