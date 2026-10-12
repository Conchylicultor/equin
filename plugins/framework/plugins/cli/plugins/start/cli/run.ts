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
import { gatewayBinary } from "@plugins/infra/plugins/launcher/deps";
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
  supportsLoginService,
  gatewayServiceState,
  writeGatewayServicePlist,
  bootstrapGatewayService,
  bootoutGatewayService,
  GATEWAY_SERVICE_LABEL,
  type GatewayLaunchOptions,
} from "@plugins/infra/plugins/launcher/server";

// The dev gateway always listens on the default port.
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

  if (supportsLoginService()) await startAsLoginService(opts);
  else await startDetached(opts);
};

/**
 * macOS: the gateway is a launchd LaunchAgent, so it comes back at login after a
 * reboot and is relaunched if it dies. launchd owns the process; this command
 * (re)writes the job, (re)loads it, and waits for it to serve.
 */
async function startAsLoginService(opts: Opts): Promise<void> {
  const service = await gatewayServiceState();
  const managedPid = service.kind === "loaded" ? service.pid : null;
  const pidfilePid = readPid();
  // A gateway launchd does not own: started by a `start` from before the
  // gateway was a launchd service.
  const legacyPid =
    pidfilePid !== null && pidfilePid !== managedPid && isRunning(pidfilePid)
      ? pidfilePid
      : null;

  if (managedPid !== null && !opts.force) {
    printRunning(
      `Gateway is already running under launchd (PID ${managedPid})`,
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
  const plist = writeGatewayServicePlist(spec);
  console.log(
    `Registered ${GATEWAY_SERVICE_LABEL} with launchd (${plist.path})`,
  );

  if (legacyPid !== null) {
    if (!opts.force) {
      // Registering is enough for the next login; swapping the live gateway
      // restarts every backend, which only an explicit --force asks for.
      console.log(
        `The running gateway (PID ${legacyPid}) was started before it was a launchd service. It keeps running now, and launchd starts it from the next login on. Run \`./singularity start --force\` to hand it to launchd now.`,
      );
      return;
    }
    console.log(
      `Stopping the gateway started outside launchd (PID ${legacyPid})...`,
    );
    await terminateProcess(legacyPid);
  }

  if (service.kind === "loaded") {
    // Unload rather than `kickstart`: launchd reads a plist only when it is
    // bootstrapped, so a rewritten job takes effect only through a reload.
    console.log("Reloading the launchd job...");
    await bootoutGatewayService();
    if (managedPid !== null) await awaitProcessGone(managedPid);
  }

  // launchd appends; truncate so the tail quoted on a failed start is this boot's.
  writeFileSync(spec.stdioLog, "");
  const pid = await bootstrapGatewayService();
  await awaitGatewayReady({ pid, port: DEFAULT_PORT });
  printRunning(
    `Gateway started under launchd (PID ${pid}); it starts again at every login`,
  );
}

/**
 * Hosts without launchd: the detached spawn. It does not survive a reboot —
 * run `./singularity start` again after one.
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
    "  Not registered with a service manager on this OS: run `./singularity start` again after a reboot.",
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
  const gateway = await ensureDep(gatewayBinary, cliExecContext(), {
    root: repoRoot,
    log: console.log,
  });
  // The launchd job (and a detached gateway) names this binary by path long
  // after main's source moves on: keep the deps sweep off it until the next
  // `start` moves the hold to a newer build.
  holdDep(gateway, "machine-gateway");
  console.log(`Gateway binary: ${gateway.dir} (${gateway.identity})`);
  ensureDatabaseConfig(repoRoot, console.log);
  return {
    gateway,
    cwd: repoRoot,
    port: DEFAULT_PORT,
    logLevel: opts.logLevel,
  };
}

function printRunning(headline: string): void {
  console.log(headline);
  console.log(`  Logs:    ${gatewayLogs.path}/`);
  console.log(`  Gateway: ${namespaceUrl(MAIN_WORKTREE_NAME)}`);
}

export default run;
