import {
  installEventsOn,
  reportInstallNotice,
  reportInstallProgress,
} from "@plugins/installer/cli";
import { writeFileSync } from "node:fs";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { assertPrerequisites } from "@plugins/framework/plugins/cli/plugins/doctor/cli";
import { installLockedToolchain } from "@plugins/infra/plugins/deps/plugins/mise/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import { ensureDep, type DepProgress } from "@plugins/infra/plugins/deps/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  adoptGatewayLaunch,
  holdGatewayBuild,
  prepareMainGateway,
  withGatewayFollowLock,
  type PreparedGateway,
} from "@plugins/infra/plugins/launcher/plugins/gateway-drift/cli";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import { startLogs } from "../data-dirs";
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
  InstallerNoticeError,
  joinNames,
  plainTextProblems,
  renderNotice,
} from "@plugins/infra/plugins/launcher/plugins/installer-notice/core";
import {
  appsBlockedNotice,
  BundleWriteRefusedError,
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
  type ServiceForUser,
} from "@plugins/infra/plugins/launcher/plugins/login-services/machine";

// What this command prints follows the installer message rules
// (`infra/launcher/installer-notice`): a person installing equin reads it, so
// every line says what they get, in their words, and the ids, PIDs and paths a
// developer wants sit on a `details:` line under it — never in the sentence.

/** The gateway, as the person installing knows it. */
const GATEWAY_FOR_USER: ServiceForUser = {
  name: "the part of equin that runs in the background",
  gives:
    "It is what opens equin in your browser, and it starts by itself every time you log in.",
};
// Declarations are checked by defineLoginService; this one by hand, at load,
// so a rule break never surfaces first inside the error path that prints it.
if (
  plainTextProblems(GATEWAY_FOR_USER.name).length +
    plainTextProblems(GATEWAY_FOR_USER.gives).length >
  0
) {
  throw new Error(
    "GATEWAY_FOR_USER breaks the installer message rules (infra/launcher/installer-notice)",
  );
}

/** The raw facts under a line a person reads: ids, PIDs, paths. */
function details(...facts: string[]): void {
  console.log(`    details: ${facts.join(" · ")}`);
}

/**
 * Where the step-by-step lines of the modules `start` drives go — the
 * dependency installs, the app bundle, each login service's reconcile, the
 * gateway's build and launch. They speak in internal names and paths ("Installed
 * gateway (<identity>) into …/equin.app"), so the terminal a person installing
 * reads never gets them: every one is appended to the last run's start log
 * (`startLogs`), named on the final `details:` line. `--verbose` also echoes
 * them, for a developer at the terminal. Every module hands its lines to the
 * `log` it is given, so this one routing covers all of them.
 */
const START_LOG = startLogs.file("start.log");

// A run writes a few dozen lines; 2 MB × 1 bounds even a runaway one.
const startLogSink = defineFileSink({
  id: "start-log",
  description:
    "`./equin start`'s detailed steps (installs, the app bundle, each login service, the background server's build and launch) — the last run, emptied by the next",
  path: START_LOG,
  maxBytes: 2 * 1024 * 1024,
  keep: 1,
});

function openStartLog(verbose: boolean): (line: string) => void {
  // The last run only: a whole-file write empties it before the first append
  // (the sink seeds its size from disk on that append).
  if (existsSync(START_LOG)) writeFileSync(START_LOG, "");
  return (line) => {
    startLogSink.appendSync(`${new Date().toISOString()} ${line}`);
    if (verbose) console.log(`    · ${line}`);
  };
}

type Opts = {
  force?: boolean;
  logLevel: string;
  only?: string;
  verbose?: boolean;
};

/** What the steps `start` drives are handed: the app bundle, and the start log. */
type Steps = { app: MacosAppHost; log: (line: string) => void };

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
  if (installed.length > 0) {
    console.log(
      "Installed the exact Bun, Go and Rust versions equin is built with.",
    );
    details(`mise installed ${installed.join(", ")}`);
  }
  // Every missing dev prerequisite at once, before the gateway compile.
  await assertPrerequisites();
  // Same host preconditions as a release launch: the dev gateway supervises
  // the same embedded cluster, so the same machine facts have to hold. A
  // refusal is a notice a person reads: printed as itself, no stack around it.
  try {
    assertSupportedHost();
  } catch (err) {
    if (!(err instanceof InstallerNoticeError)) throw err;
    console.error(err.message);
    process.exit(1);
  }

  // Opened after the host checks: a refused start writes nothing.
  const log = openStartLog(opts.verbose === true);
  // The equin app bundle every service runs from on macOS (a no-op elsewhere).
  const steps: Steps = {
    app: machineMacosAppHost({ exec: cliExecContext() }, log),
    log,
  };
  // Named however the run ends — done, refused, or failed — since a failure is
  // when someone reads it. (The refused-gateway exit names it itself.)
  try {
    await startSelected(opts, steps, {
      manager,
      gatewayService,
      gateway: selected(gatewayLabel),
      declared: declared.filter((d) => selected(d.id)),
    });
  } finally {
    details(`start log ${START_LOG}`);
  }
};

async function startSelected(
  opts: Opts,
  steps: Steps,
  services: {
    manager: LoginServiceManager | null;
    gatewayService: LoginService | null;
    /** Whether `--only` keeps the gateway. */
    gateway: boolean;
    declared: readonly LoginServiceDeclaration[];
  },
): Promise<void> {
  const { manager, gatewayService, gateway, declared } = services;
  if (gateway) {
    // Under the lock main's follow-main step swaps the gateway with, so a
    // person's start never interleaves with an automatic restart.
    try {
      await withGatewayFollowLock(() =>
        gatewayService
          ? startAsLoginService(gatewayService, opts, steps)
          : startDetached(opts, steps),
      );
    } catch (err) {
      if (!(err instanceof BundleWriteRefusedError)) throw err;
      // Not optional: without it there is no equin to open.
      console.error(
        renderNotice(
          appsBlockedNotice([err], [GATEWAY_FOR_USER], {
            optional: false,
            because: "without it, equin cannot open in your browser.",
          }),
        ),
      );
      details(`start log ${START_LOG}`);
      process.exit(1);
    }
  }
  // Then every login service a plugin declares — none named here.
  await startDeclaredLoginServices(manager, declared, opts, steps);
}

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
  steps: Steps,
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
    printRunning("equin is already running.", [
      `${loginService.id.label} under ${manager}`,
      `PID ${managedPid}`,
    ]);
    await reportStaleGateway(loginService, opts, steps);
    return;
  }
  if (
    managedPid === null &&
    legacyPid === null &&
    (await isGatewayListening(DEV_GATEWAY_PORT))
  ) {
    printRunning("equin is already running (started outside this command).", [
      `port ${DEV_GATEWAY_PORT} answers`,
    ]);
    return;
  }

  announcePrepare();
  const prepared = await prepareGateway(opts, steps);
  const launch = await adoptAndHold(prepared, steps);
  const spec = gatewayLaunchSpec(launch);
  const written = await loginService.write(gatewayServiceJob(spec));
  console.log("Set equin to start by itself every time you log in.");
  details(`${loginService.id.label} registered with ${manager}`, written.path);

  if (legacyPid !== null) {
    if (!opts.force) {
      // Registering is enough for the next login/boot; swapping the live
      // gateway restarts every backend, which only an explicit --force asks for.
      console.log(
        `equin keeps running as it is, and starts by itself from your next ${loginService.startsAt} on. To switch now (open apps reload), run \`./equin start --only ${loginService.id.label} --force\`.`,
      );
      details(`running PID ${legacyPid} was started outside ${manager}`);
      return;
    }
    console.log("Restarting equin (open apps reload)...");
    details(`stopping PID ${legacyPid}, started outside ${manager}`);
    await terminateProcess(legacyPid);
  }

  // The manager appends; truncate so the tail quoted on a failed start is this boot's.
  const truncateLog = () => writeFileSync(spec.stdioLog, "");
  let pid: number | null;
  if (service.kind === "loaded") {
    // Unload rather than restart in place: neither manager re-reads a job
    // definition while it is loaded, so a rewritten job takes effect only
    // through a reload — one that always loads once it has unloaded.
    console.log("Restarting equin (open apps reload)...");
    details(`reloading the ${manager} job`);
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
    `equin is running, and starts by itself at every ${loginService.startsAt}.`,
    [`${loginService.id.label} under ${manager}`, `PID ${pid}`],
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
  steps: Steps,
): Promise<void> {
  console.log("Checking whether equin has an update ready...");
  const { gateway, launch } = await prepareGateway(opts, steps);
  if (
    await loginService.isCurrent(gatewayServiceJob(gatewayLaunchSpec(launch)))
  )
    return;
  console.log(
    `An update to equin is ready. To install it now (open apps reload), run \`./equin start --only ${loginService.id.label} --force\`.`,
  );
  details(
    `the running gateway's job differs from main's`,
    `binary ${gateway.dir}`,
    `identity ${gateway.identity}`,
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
  steps: Steps,
): Promise<void> {
  if (declared.length === 0) return;
  if (manager === null) {
    console.log(
      `Left out ${listNames(declared)}: this system has no way to start programs when you log in. equin works without ${declared.length > 1 ? "them" : "it"}, in your browser.`,
    );
    details(`no service manager for ${declared.map((d) => d.id).join(", ")}`);
    return;
  }
  const root = await getMainRepoRoot();
  const skipped: {
    decl: LoginServiceDeclaration;
    err: BundleWriteRefusedError;
  }[] = [];
  for (const decl of declared) {
    const ready = await ensureDep(decl.dep, cliExecContext(), {
      root,
      log: steps.log,
      // Run by an install: its window counts the helper's crates.
      ...(installEventsOn()
        ? {
            progress: (p: DepProgress) =>
              reportInstallProgress(p.done, p.total, p.unit),
          }
        : {}),
    });
    try {
      const { service, outcome } = await reconcileLoginService(
        manager,
        decl,
        ready,
        opts.force ? "force" : "start",
        { host: steps.app, log: steps.log },
      );
      console.log(describeStart(decl.forUser, outcome, service));
      details(
        `${decl.id} (${decl.owner}) under ${service.manager}`,
        ...startFacts(outcome),
      );
    } catch (err) {
      // A declared service is optional: equin runs without it (the gateway,
      // and so the app, is already up). A machine policy refusing the bundle
      // write is a state to report, never the end of the install.
      if (!(err instanceof BundleWriteRefusedError)) throw err;
      skipped.push({ decl, err });
    }
  }
  if (skipped.length > 0) {
    const ids = skipped.map((s) => s.decl.id).join(",");
    console.log(
      renderNotice(
        appsBlockedNotice(
          skipped.map((s) => s.err),
          skipped.map((s) => s.decl.forUser),
          {
            optional: true,
            appUrl: namespaceUrl(MAIN_WORKTREE_NAME),
            addLater: `Once it is allowed, \`./equin start --only ${ids}\` adds ${skipped.length > 1 ? "them" : "it"}.`,
          },
        ),
      ),
    );
    // Run by an install: its window shows it while the build goes on, and
    // offers to add them back once it is done (Add it now).
    reportInstallNotice({
      id: ids,
      state: "skipped",
      title: "macOS blocked equin from adding its apps",
      text: "With them, equin's apps open in their own windows and get a menu-bar icon. To allow it, turn on Terminal in Privacy & Security, App Management. It's optional: skip it and use equin in your browser.",
      without: "the menu-bar icon and app shortcuts",
    });
  }
}

/** "a, b and c", by the names a person knows them by. */
function listNames(declared: readonly LoginServiceDeclaration[]): string {
  return joinNames(declared.map((d) => d.forUser.name));
}

/** The raw facts of a start: PID, schedule, the definition's path. */
function startFacts(outcome: ReconcileOutcome): string[] {
  switch (outcome.kind) {
    case "unchanged":
      return [`PID ${outcome.pid ?? "none"}`];
    case "started":
      return [
        `${outcome.reloaded ? "reloaded" : "loaded"}, PID ${outcome.pid ?? "none"}`,
        outcome.path,
      ];
    // Only `follow` stops short of loading (describeStart throws on these).
    case "unregistered":
    case "rewritten":
      return [];
  }
}

function describeStart(
  forUser: ServiceForUser,
  outcome: ReconcileOutcome,
  service: LoginService,
): string {
  const name = forUser.name.charAt(0).toUpperCase() + forUser.name.slice(1);
  switch (outcome.kind) {
    case "unchanged":
      return `${name} is already on.`;
    case "started":
      return service.id.schedule === undefined
        ? `${outcome.reloaded ? "Updated" : "Added"} ${forUser.name}; it comes back by itself at every ${service.startsAt}. ${forUser.gives}`
        : `${outcome.reloaded ? "Updated" : "Turned on"} ${forUser.name}; it runs every ${service.id.schedule.everySeconds} seconds. ${forUser.gives}`;
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
async function startDetached(opts: Opts, steps: Steps): Promise<void> {
  const existingPid = await readPid();
  const pidAlive = existingPid !== null && isRunning(existingPid);

  if (!pidAlive && (await isGatewayListening(DEV_GATEWAY_PORT))) {
    printRunning("equin is already running (started outside this command).", [
      `port ${DEV_GATEWAY_PORT} answers`,
    ]);
    return;
  }

  if (pidAlive) {
    if (!opts.force) {
      printRunning("equin is already running.", [`PID ${existingPid}`]);
      return;
    }
    console.log("Restarting equin (open apps reload)...");
    details(`stopping PID ${existingPid}`);
    await terminateProcess(existingPid!);
  }

  announcePrepare();
  const launch = await adoptAndHold(await prepareGateway(opts, steps), steps);
  // `.pid` only, and no `.ref()`: the gateway deliberately outlives `start`.
  const { pid } = await spawnGatewayDaemon(launch);

  // Wait for the gateway to actually serve before claiming success. It exits
  // when a managed service fails to start, so printing unconditionally
  // reported success for an already-dead gateway.
  await awaitGatewayReady({ pid, port: DEV_GATEWAY_PORT });
  printRunning(
    "equin is running. This system cannot start it by itself when you log in: after a restart, run `./equin start` again.",
    [`PID ${pid}`, "no service manager"],
  );
}

/** Main's gateway build and the launch that would run it (`gateway-drift/cli`). */
function prepareGateway(
  opts: Opts,
  { app, log }: Steps,
): Promise<PreparedGateway> {
  return prepareMainGateway({ logLevel: opts.logLevel, app, log });
}

/** Said before a launch's prepare: a first build is minutes of silence otherwise. */
function announcePrepare(): void {
  console.log(
    `Preparing ${GATEWAY_FOR_USER.name} (a few minutes the first time)...`,
  );
}

/**
 * Apply a prepared launch and hold its build: `start` has no way back to
 * offer (a person runs it, and reads its failure), so the hold moves at once —
 * unlike main's follow-main restart, which holds only once the new gateway
 * answers.
 */
async function adoptAndHold(
  prepared: PreparedGateway,
  steps: Steps,
): Promise<GatewayLaunchOptions> {
  const launch = await adoptGatewayLaunch(prepared, steps.app, steps.log);
  await holdGatewayBuild(prepared.gateway);
  return launch;
}

function printRunning(headline: string, facts: string[]): void {
  console.log(headline);
  console.log(`  Its address: ${namespaceUrl(MAIN_WORKTREE_NAME)}`);
  details(...facts, `logs ${gatewayLogs.path}/`);
}

export default run;
