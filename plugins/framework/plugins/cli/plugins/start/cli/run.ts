import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  gatewayBinary,
  signGateway,
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
  awaitProcessGone,
  terminateProcess,
  resolveListenAddress,
  LISTEN_ENV,
  GATEWAY_SERVICE,
  gatewayServiceJob,
  type GatewayLaunchOptions,
} from "@plugins/infra/plugins/launcher/server";
import {
  declaredLoginServices,
  loginServiceHolder,
  loginServiceId,
  loginServiceJob,
  loginServiceManager,
  type LoginService,
  type LoginServiceManager,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";

// The dev gateway always listens on the default port: every backend reaches
// central through `localhost:9000`.
const DEFAULT_PORT = 9000;

type Opts = { force?: boolean; logLevel: string };

const run: CliAction<[], Opts> = async (opts) => {
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
  if (manager)
    await startAsLoginService(manager.service(GATEWAY_SERVICE), opts);
  else await startDetached(opts);
  // Then every login service a plugin declares — none named here.
  await startDeclaredLoginServices(manager, opts);
};

/**
 * The gateway is a per-user OS service (a launchd LaunchAgent on macOS, a
 * systemd user unit on Linux), so it comes back after a reboot and is
 * relaunched if it dies. The manager owns the process; this command (re)writes
 * the job, (re)loads it, and waits for it to serve.
 */
async function startAsLoginService(
  loginService: LoginService,
  opts: Opts,
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
    return;
  }
  if (
    managedPid === null &&
    legacyPid === null &&
    (await isGatewayListening(DEFAULT_PORT))
  ) {
    printRunning(
      "Gateway is already running on port 9000 (started externally).",
    );
    return;
  }

  const spec = gatewayLaunchSpec(await prepareGateway(opts));
  const written = loginService.write(gatewayServiceJob(spec));
  console.log(
    `Registered ${GATEWAY_SERVICE.label} with ${manager} (${written.path})`,
  );

  if (legacyPid !== null) {
    if (!opts.force) {
      // Registering is enough for the next login/boot; swapping the live
      // gateway restarts every backend, which only an explicit --force asks for.
      console.log(
        `The running gateway (PID ${legacyPid}) was started before it was a ${manager} service. It keeps running now, and ${manager} starts it from the next ${loginService.startsAt} on. Run \`./equin start --force\` to hand it to ${manager} now.`,
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
  await awaitGatewayReady({ pid, port: DEFAULT_PORT });
  printRunning(
    `Gateway started under ${manager} (PID ${pid}); it starts again at every ${loginService.startsAt}`,
  );
}

/**
 * Every login service a plugin declares (`login-services/index.ts`, collected
 * by `infra/launcher/login-services`), after the gateway: each one's dependency
 * ensured from the MAIN checkout and held — like the gateway binary, the job
 * names it by path long after main moves on — its job (re)written, and
 * (re)loaded when it is not running, its job changed, or `--force`.
 */
async function startDeclaredLoginServices(
  manager: LoginServiceManager | null,
  opts: Opts,
): Promise<void> {
  const declared = await declaredLoginServices();
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
    holdDep(ready, loginServiceHolder(decl));
    const service = manager.service(loginServiceId(decl));
    const before = await service.state();
    const job = loginServiceJob(decl, ready);
    const written = service.write(job);
    const runningPid = before.kind === "loaded" ? before.pid : null;
    if (runningPid !== null && !written.changed && !opts.force) {
      console.log(
        `${decl.id} (${decl.owner}) is already running under ${manager.manager} (PID ${runningPid})`,
      );
      continue;
    }
    if (before.kind === "loaded") {
      // Neither manager re-reads a loaded job: a rewritten one takes effect
      // only through a reload.
      await service.unload();
      if (runningPid !== null) await awaitProcessGone(runningPid);
    }
    // The manager appends; truncate so the log holds this start's output. Its
    // folder may not exist yet (a declaration's first start), and neither
    // launchd nor systemd creates it — the job would fail to spawn.
    mkdirSync(dirname(job.stdioLog), { recursive: true });
    writeFileSync(job.stdioLog, "");
    const pid = await service.load();
    console.log(
      `${decl.id} (${decl.owner}) started under ${manager.manager} (PID ${pid}); it starts again at every ${service.startsAt} (${written.path})`,
    );
  }
}

/**
 * Hosts without a service manager: the detached spawn. It does not survive a reboot —
 * run `./equin start` again after one.
 */
async function startDetached(opts: Opts): Promise<void> {
  const existingPid = readPid();
  const pidAlive = existingPid !== null && isRunning(existingPid);

  if (!pidAlive && (await isGatewayListening(DEFAULT_PORT))) {
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

  const launch = await prepareGateway(opts);
  // `.pid` only, and no `.ref()`: the gateway deliberately outlives `start`.
  const { pid } = spawnGatewayDaemon(launch);

  // Wait for the gateway to actually serve before claiming success. It exits
  // when a managed service fails to start, so printing unconditionally
  // reported success for an already-dead gateway.
  await awaitGatewayReady({ pid, port: DEFAULT_PORT });
  printRunning(`Gateway started (PID ${pid})`);
  console.log(
    "  Not registered with a service manager on this OS: run `./equin start` again after a reboot.",
  );
}

/** Ensure the gateway binary and write `database.json` — the inputs to any launch. */
async function prepareGateway(opts: Opts): Promise<GatewayLaunchOptions> {
  // The machine's gateway is MAIN's: built from the main checkout's Go source
  // whichever checkout runs `start`.
  const repoRoot = await getMainRepoRoot();
  // Built only when main's gateway source (or Go) changed since the last
  // build — the identity is the source hash — so a Go change takes effect
  // on the next `start` with no flag, and an unchanged one costs a hash.
  const exec = cliExecContext();
  const gateway = await ensureDep(gatewayBinary, exec, {
    root: repoRoot,
    log: console.log,
  });
  // A ready install skips the build's signing step, so a changed identity
  // (configured, or a reset local one) is applied here; a no-op otherwise.
  await signGateway(gateway, exec, console.log);
  // The service job (and a detached gateway) names this binary by path long
  // after main's source moves on: keep the deps sweep off it until the next
  // `start` moves the hold to a newer build.
  holdDep(gateway, "machine-gateway");
  console.log(`Gateway binary: ${gateway.dir} (${gateway.identity})`);
  ensureDatabaseConfig(repoRoot, console.log);
  return {
    gateway,
    cwd: repoRoot,
    port: DEFAULT_PORT,
    bindHost: devBindHost(),
    logLevel: opts.logLevel,
  };
}

/**
 * Where the dev gateway binds: loopback by default (127.0.0.1 and [::1]), or the
 * host `SINGULARITY_LISTEN` names — the one listen override a release honours
 * too. Every interface is the explicit opt-in `SINGULARITY_LISTEN=:9000`, so the
 * agent manager is off-box only when someone asked for it. Only the HOST may
 * change: every backend reaches central at `localhost:9000`.
 */
function devBindHost(): string | null {
  const addr = resolveListenAddress(DEFAULT_PORT);
  if (addr.port !== DEFAULT_PORT) {
    throw new Error(
      `${LISTEN_ENV} names port ${addr.port}, but the dev gateway must listen on ${DEFAULT_PORT} (backends reach central at localhost:${DEFAULT_PORT}). Set only the host, e.g. ${LISTEN_ENV}=127.0.0.1:${DEFAULT_PORT}.`,
    );
  }
  console.log(
    addr.host === null
      ? `Binding the gateway to every interface (${LISTEN_ENV}=:${DEFAULT_PORT})`
      : `Binding the gateway to ${addr.host}:${DEFAULT_PORT}`,
  );
  return addr.host;
}

function printRunning(headline: string): void {
  console.log(headline);
  console.log(`  Logs:    ${gatewayLogs.path}/`);
  console.log(`  Gateway: ${namespaceUrl(MAIN_WORKTREE_NAME)}`);
}

export default run;
