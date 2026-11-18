import {
  installEventsOn,
  installLeftOut,
  reportInstallDiagnosis,
  reportInstallNotice,
  reportInstallProgress,
} from "@plugins/installer/cli";
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
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
import {
  declaredDeps,
  ensureDep,
  MissingSystemPackagesError,
  systemPackagesToPrepare,
  type DepProgress,
} from "@plugins/infra/plugins/deps/deps";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  adoptGatewayLaunch,
  holdGatewayBuild,
  prepareMainGateway,
  withGatewayFollowLock,
  type PreparedGateway,
} from "@plugins/infra/plugins/launcher/plugins/gateway-drift/cli";
import { assertThisInstance } from "@plugins/infra/plugins/launcher/plugins/instance-owner/cli";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import { startLogs } from "../data-dirs";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import {
  GATEWAY_PORT_RANGE,
  LEGACY_GATEWAY_PORT,
  MAIN_WORKTREE_NAME,
  isGatewayPort,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import type { GatewayPortRecord } from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";
import {
  chooseGatewayPort,
  describeChoice,
  portHolder,
  probeGateway,
  writeGatewayPortRecord,
} from "@plugins/infra/plugins/launcher/plugins/gateway-port/machine";
import {
  gatewayPortSync,
  readGatewayPortRecordSync,
} from "@plugins/infra/plugins/launcher/plugins/gateway-port/data-dirs";
import { listenPortOf } from "@plugins/infra/plugins/launcher/plugins/gateway-drift/machine";
import {
  assertSupportedHost,
  readPid,
  isRunning,
  spawnGatewayDaemon,
  gatewayLaunchSpec,
  awaitGatewayReady,
  gatewayServiceJob,
  type GatewayLaunchOptions,
} from "@plugins/infra/plugins/launcher/server";
import {
  defineNotice,
  InstallerNoticeError,
  type InstallerNotice,
  joinNames,
  plainTextProblems,
  renderNotice,
} from "@plugins/infra/plugins/launcher/plugins/installer-notice/core";
import {
  appsBlockedNotice,
  BundleWriteRefusedError,
  declaredLoginServices,
  hostDesktop,
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
  leaveOut?: string;
  logLevel: string;
  only?: string;
  systemPackages?: boolean;
  port?: string;
  verbose?: boolean;
};

/**
 * The port this start launches the gateway on, and what it records once the
 * gateway answers there (`launcher/gateway-port`): the record it keeps, a
 * fresh choice, a move off 9000, or `--port`.
 */
type PortPlan = {
  record: GatewayPortRecord;
  /** The port the running gateway listens on now (to say what moved), or null. */
  from: number | null;
  /** What to say about it, or null when nothing changed. */
  said: string | null;
};

/**
 * What the steps `start` drives are handed: the app bundle, the start log and
 * the port.
 */
type Steps = {
  app: MacosAppHost;
  log: (line: string) => void;
  port: PortPlan;
};

/** The line `--system-packages` answers on (install.sh's `start_services` reads it). */
const SYSTEM_PACKAGES_MARK = "system-packages:";
/**
 * The lines `--system-packages` names a dependency's own install command on,
 * one per command: `system-setup:<what, in words>` then the argv, every field
 * tab-separated (install.sh runs it as root).
 */
const SYSTEM_SETUP_MARK = "system-setup:";

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
  const parts = await partsHere(
    declared.filter((d) => selected(d.id)),
    leaveOutIds(opts.leaveOut, declared),
  );
  // install.sh asks this before the start step runs: what the OS must
  // provide for the parts this start would add here, and for the dependencies
  // every install prepares (`SystemPackages.everyInstall`), so it installs
  // them (one sudo) from the declarations, never from a list of its own.
  if (opts.systemPackages) {
    const prepare = await systemPackagesToPrepare(
      manager === null ? [] : parts.add.map((d) => d.dep),
      await declaredDeps(),
      await getWorktreeRoot(),
    );
    // Marked lines only: anything else on stdout (a dependency install's
    // output) never reaches apt or sudo.
    console.log(`${SYSTEM_PACKAGES_MARK}${prepare.apt.join(" ")}`);
    for (const c of prepare.commands) {
      for (const field of [c.forUser, ...c.argv])
        if (field.includes("\t") || field.includes("\n"))
          throw new Error(
            `--system-packages: ${JSON.stringify(field)} holds a tab or a newline, which the system-setup line cannot carry`,
          );
      console.log(`${SYSTEM_SETUP_MARK}${[c.forUser, ...c.argv].join("\t")}`);
    }
    return;
  }
  // One equin per account: a second checkout of the repo would share this
  // account's database, address and background service, so starting it would
  // take over the equin running from another one (`instance-owner`). Asked
  // before anything is installed, built or restarted.
  try {
    await assertThisInstance(await getMainRepoRoot(), "start");
  } catch (err) {
    if (!(err instanceof InstallerNoticeError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
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
    port: await planPort(opts, gatewayService),
  };
  if (manager !== null) sayLeftOut(parts);
  // Named however the run ends — done, refused, or failed — since a failure is
  // when someone reads it. (The refused-gateway exit names it itself.)
  try {
    await startSelected(opts, steps, {
      manager,
      gatewayService,
      gateway: selected(gatewayLabel),
      declared: parts.add,
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
  // Every declared service's program BEFORE the gateway: the gateway's first
  // boot deploys main (a convergence run, minutes of build holding the host's
  // build slot), and a program built after it would queue behind that whole
  // build (2026-11-18 fresh installs: the disk-speed check's 5 s compile
  // waited 9 minutes for main's first build). Built first, nothing here waits
  // for anything but itself.
  const ensuredDeps =
    manager === null ? null : await ensureServiceDeps(declared, steps);
  // In an install, a part that could not be prepared stops `start` HERE,
  // before the gateway: fixed and tried again, the retry builds with nothing
  // else on the machine (started, the gateway's first boot deploys main, and
  // the retry's build would queue minutes behind it for the host's build
  // slot — 2026-11-18, Linux VMs: 32 s to 5 min). Skip starts equin without
  // it. Run by hand, equin itself comes first: the gateway starts (or
  // restarts, `--force`) and `start` fails on the part afterwards — an
  // optional part never holds the app.
  const failed = ensuredDeps?.failed ?? [];
  if (failed.length > 0 && installEventsOn()) failParts(failed);
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
  await startDeclaredLoginServices(
    manager,
    declared.filter((d) => !failed.some((f) => f.decl === d)),
    ensuredDeps?.ready ?? null,
    opts,
    steps,
  );
  if (failed.length > 0) failParts(failed);
}

/**
 * The parts `start` could not prepare: the notice on the terminal, the same
 * words as the install step's own diagnosis (its pause, with Skip), exit 1.
 */
function failParts(failed: readonly FailedPart[]): never {
  const notice = partsFailedNotice(failed);
  console.error(renderNotice(notice));
  reportInstallDiagnosis({
    title: notice.title,
    text: pauseText(notice, failed),
    leaveOut: {
      ids: failed.map((f) => f.decl.id),
      without: listNames(failed.map((f) => f.decl)),
      later: notice.ifSkipped.optional
        ? `${notice.ifSkipped.stillWorks} ${notice.ifSkipped.addLater}`
        : "",
    },
    evidence: notice.evidence,
  });
  details(`start log ${START_LOG}`);
  process.exit(1);
}

/**
 * The selected login services, split by what this start does with each:
 * `add` them, leave them out because this machine has no desktop to show a
 * `graphical` one on (nothing is built, registered or asked of the OS for
 * it), or leave them out because the person chose to (`--leave-out`, or an
 * install's Skip: `EQUIN_INSTALL_LEFT_OUT`).
 */
type PartsHere = {
  add: LoginServiceDeclaration[];
  noDesktop: {
    decls: LoginServiceDeclaration[];
    why: string;
    evidence: string;
  };
  chosen: LoginServiceDeclaration[];
};

async function partsHere(
  selected: readonly LoginServiceDeclaration[],
  leaveOut: ReadonlySet<string>,
): Promise<PartsHere> {
  const desktop = await hostDesktop();
  const parts: PartsHere = {
    add: [],
    noDesktop: {
      decls: [],
      why: desktop.desktop ? "" : desktop.why,
      evidence: desktop.desktop ? "" : desktop.evidence,
    },
    chosen: [],
  };
  for (const decl of selected) {
    if (leaveOut.has(decl.id)) parts.chosen.push(decl);
    else if (!desktop.desktop && decl.session === "graphical")
      parts.noDesktop.decls.push(decl);
    else parts.add.push(decl);
  }
  return parts;
}

/**
 * `--leave-out <ids>` plus the parts an install's Skip left out, each a
 * declared login service id; an unknown one throws, listing the known ones.
 */
function leaveOutIds(
  flag: string | undefined,
  declared: readonly LoginServiceDeclaration[],
): ReadonlySet<string> {
  const ids = [
    ...(flag ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
    ...installLeftOut(),
  ];
  const known = declared.map((d) => d.id);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0)
    throw new Error(
      `--leave-out: unknown service${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Known: ${known.join(", ")}.`,
    );
  return new Set(ids);
}

/** What `start` leaves out, said once, before anything is built. */
function sayLeftOut(parts: PartsHere): void {
  const { noDesktop, chosen } = parts;
  if (noDesktop.decls.length > 0) {
    console.log(
      `Left out ${listNames(noDesktop.decls)}: ${noDesktop.why}. equin works without ${noDesktop.decls.length > 1 ? "them" : "it"}, in your browser.`,
    );
    details(noDesktop.decls.map((d) => d.id).join(", "), noDesktop.evidence);
  }
  if (chosen.length > 0) {
    console.log(
      `Left out ${listNames(chosen)}, as you chose. To add ${chosen.length > 1 ? "them" : "it"} later, run \`./equin start\` again.`,
    );
    details(`left out: ${chosen.map((d) => d.id).join(", ")}`);
  }
}

type FailedPart = { decl: LoginServiceDeclaration; error: unknown };

/**
 * The parts `start` could not prepare, as the installer notice a person
 * reads: what each gives them, why it failed in their words (the OS libraries
 * it needs, or a build that failed — its output only in the evidence), and
 * that it is optional.
 */
function partsFailedNotice(failed: readonly FailedPart[]): InstallerNotice {
  const decls = failed.map((f) => f.decl);
  const names = listNames(decls);
  const missing = failed.flatMap((f) =>
    f.error instanceof MissingSystemPackagesError ? [f.error] : [],
  );
  const commands = installCommands(missing);
  const them = failed.length > 1 ? "them" : "it";
  return defineNotice({
    title: `equin couldn't add ${names}`,
    doing: `It was adding ${names}. ${decls.map((d) => d.forUser.gives).join(" ")}`,
    blocked:
      missing.length === failed.length
        ? `${failed.length > 1 ? "They need" : "It needs"} ${joinNames([...new Set(missing.map((m) => m.forUser))])}, which aren't installed on this computer.`
        : `${failed.length > 1 ? "They are" : "It is"} built on this computer, and that build failed.`,
    now: [
      commands.length > 0
        ? `Install what ${failed.length > 1 ? "they need" : "it needs"} with ${commands.map((c) => `\`sudo ${c}\``).join(" and ")}, then run \`./equin start\` again.`
        : "Fix what stopped the build (its last lines are in the details), then run `./equin start` again.",
      `Or start equin without ${them}: \`./equin start --leave-out ${decls.map((d) => d.id).join(",")}\`.`,
    ],
    ifSkipped: {
      optional: true,
      stillWorks: `equin works without ${them}, in your browser.`,
      addLater: `To add ${them} later, run \`./equin start\` again in equin's folder.`,
    },
    evidence: failed.flatMap((f) => [
      `${f.decl.id} (${f.decl.dep.id}):`,
      ...errorTail(f.error),
    ]),
  });
}

/**
 * The same notice as an install's pause: one paragraph, its actions the
 * pause's own buttons (Try again, Skip, Fix with Claude).
 */
function pauseText(
  notice: InstallerNotice,
  failed: readonly FailedPart[],
): string {
  const missing = failed.flatMap((f) =>
    f.error instanceof MissingSystemPackagesError ? [f.error] : [],
  );
  const commands = installCommands(missing);
  const them = failed.length > 1 ? "them" : "it";
  const act =
    commands.length > 0
      ? `Install ${them === "it" ? "what it needs" : "what they need"} with ${commands.map((c) => `\`sudo ${c}\``).join(" and ")}, then Try again.`
      : "Fix with Claude reads what went wrong first; Try again builds it again.";
  return `${notice.doing} ${notice.blocked} ${act} It's optional: Skip starts equin without ${them}, and equin works in your browser. ${notice.ifSkipped.optional ? notice.ifSkipped.addLater : ""}`.trim();
}

/**
 * The commands (run as root) that install what the failed parts lack: one apt
 * line for every listed package, then each dependency tool's own command.
 */
function installCommands(
  missing: readonly MissingSystemPackagesError[],
): string[] {
  const apt = [...new Set(missing.flatMap((m) => m.apt))];
  return [
    ...(apt.length > 0 ? [`apt-get install ${apt.join(" ")}`] : []),
    ...new Set(
      missing.filter((m) => m.apt.length === 0).map((m) => m.command.join(" ")),
    ),
  ];
}

/** An error's last lines, the home folder as `~` (evidence a person may share). */
function errorTail(error: unknown): string[] {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-20)
    .map((l) => l.split(HOME_DIR).join("~"));
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

  // `--port` is a restart, like --force. A running install still on 9000 is
  // left where it is — main's next deploy moves it (gateway-drift's follow):
  // a plain `start` never restarts a running gateway.
  const moving =
    opts.port !== undefined && steps.port.from !== steps.port.record.port;
  if (managedPid !== null && !opts.force && !moving) {
    printRunning("equin is already running.", runningPort(steps.port), [
      `${loginService.id.label} under ${manager}`,
      `PID ${managedPid}`,
    ]);
    await reportStaleGateway(loginService, opts, steps);
    return;
  }
  if (managedPid === null && legacyPid === null) {
    if (await answeredByOurs(steps.port.record.port)) return;
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
  await awaitGatewayReady({ pid, port: steps.port.record.port });
  await recordPort(steps.port);
  printRunning(
    `equin is running, and starts by itself at every ${loginService.startsAt}.`,
    steps.port.record.port,
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
 * Each selected login service's dependency, ensured from the MAIN checkout — a
 * CLI may build in the foreground — in declaration order, before the gateway
 * starts (see `startSelected`). A failed one is kept as its error, not thrown
 * here: `startSelected` decides when `start` fails on it — before the gateway
 * in an install, after it by hand.
 */
async function ensureServiceDeps(
  declared: readonly LoginServiceDeclaration[],
  steps: Steps,
): Promise<EnsuredDeps> {
  const root = await getMainRepoRoot();
  const ensured: EnsuredDeps = { ready: new Map(), failed: [] };
  for (const decl of declared) {
    try {
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
      ensured.ready.set(decl, ready);
    } catch (error) {
      // Whatever it was, `start` fails on it as a notice naming the part
      // (`startSelected`: before the gateway in an install) — never lost.
      ensured.failed.push({ decl, error });
    }
  }
  return ensured;
}

type EnsuredDeps = {
  ready: Map<LoginServiceDeclaration, Awaited<ReturnType<typeof ensureDep>>>;
  failed: FailedPart[];
};

/**
 * Every login service a plugin declares (`login-services/index.ts`, collected
 * by `infra/launcher/login-services`) that `--only` selects, after the gateway,
 * from its dependency ensured before it (`ensureServiceDeps`): reconciled
 * (`reconcileLoginService`, the body main's boot shares) — held, its job
 * (re)written, and (re)loaded when it is not running, its job changed, or
 * `--force`.
 */
async function startDeclaredLoginServices(
  manager: LoginServiceManager | null,
  declared: readonly LoginServiceDeclaration[],
  ensuredDeps: EnsuredDeps["ready"] | null,
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
  const skipped: {
    decl: LoginServiceDeclaration;
    err: BundleWriteRefusedError;
  }[] = [];
  for (const decl of declared) {
    const ready = ensuredDeps?.get(decl);
    if (ready === undefined)
      throw new Error(
        `${decl.id}: its dependency was not ensured before the gateway started`,
      );
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
            appUrl: namespaceUrl(MAIN_WORKTREE_NAME, "", gatewayPortSync()),
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

  if (!pidAlive && (await answeredByOurs(steps.port.record.port))) return;

  // `--port` is a restart, like --force. A running install still on 9000 is
  // left where it is — main's next deploy moves it (gateway-drift's follow):
  // a plain `start` never restarts a running gateway.
  const moving =
    opts.port !== undefined && steps.port.from !== steps.port.record.port;
  if (pidAlive) {
    if (!opts.force && !moving) {
      printRunning("equin is already running.", runningPort(steps.port), [
        `PID ${existingPid}`,
      ]);
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
  await awaitGatewayReady({ pid, port: steps.port.record.port });
  await recordPort(steps.port);
  printRunning(
    "equin is running. This system cannot start it by itself when you log in: after a restart, run `./equin start` again.",
    steps.port.record.port,
    [`PID ${pid}`, "no service manager"],
  );
}

/** Main's gateway build and the launch that would run it (`gateway-drift/cli`). */
function prepareGateway(
  opts: Opts,
  { app, log, port }: Steps,
): Promise<PreparedGateway> {
  return prepareMainGateway({
    logLevel: opts.logLevel,
    port: port.record.port,
    legacyPort: port.record.legacy,
    app,
    log,
  });
}

/**
 * The port this start launches on (see {@link PortPlan}):
 *
 * - `--port <n>`: that one, if it is in the range and free (or this
 *   account's gateway already holds it);
 * - else the recorded one — kept for good, since bookmarks and OAuth redirect
 *   URIs name it;
 * - else, an install still on 9000 (its job's `-listen`) moves to the first
 *   free port of the range, 9000 kept answering for a while;
 * - else (a fresh install) the first free port of the range.
 *
 * Nothing is written here: the record is written once the gateway answers.
 */
async function planPort(
  opts: Opts,
  gatewayService: LoginService | null,
): Promise<PortPlan> {
  const read = readGatewayPortRecordSync();
  const installed = await gatewayService?.installedJob();
  const installedPort =
    installed === null || installed === undefined
      ? null
      : listenPortOf(installed.argv.slice(1));
  const from = read.kind === "set" ? read.record.port : installedPort;
  // Moved off 9000 at some point (now or before): 9000 keeps answering.
  const legacy =
    read.kind === "set"
      ? read.record.legacy
      : installedPort === LEGACY_GATEWAY_PORT
        ? LEGACY_GATEWAY_PORT
        : null;
  if (opts.port !== undefined) {
    const port = Number(opts.port);
    if (!isGatewayPort(port)) {
      throw new Error(
        `--port ${opts.port}: equin uses one of ${GATEWAY_PORT_RANGE.first}–${GATEWAY_PORT_RANGE.last}.`,
      );
    }
    if (port !== from) {
      const probe = await probeGateway(port);
      if (probe.kind !== "none") {
        throw new Error(
          `--port ${port}: the port is taken (${describeProbe(probe)}). Pick another of ${GATEWAY_PORT_RANGE.first}–${GATEWAY_PORT_RANGE.last}.`,
        );
      }
    }
    return {
      record: { port, legacy },
      from,
      said: port === from ? null : `equin moves to port ${port}.`,
    };
  }
  if (read.kind === "set") return { record: read.record, from, said: null };
  const choice = await chooseGatewayPort();
  return {
    record: { port: choice.port, legacy },
    from,
    said:
      legacy === null
        ? describeChoice(choice)
        : `equin moves off port ${LEGACY_GATEWAY_PORT}, which other programs often use: ${describeChoice(choice)} Old addresses on ${LEGACY_GATEWAY_PORT} keep working for a while and open the new one.`,
  };
}

/** The port a gateway this start leaves running listens on: the one it had. */
function runningPort(plan: PortPlan): number {
  return plan.from ?? plan.record.port;
}

/** Who holds a port, in words. */
function describeProbe(
  probe: Exclude<Awaited<ReturnType<typeof probeGateway>>, { kind: "none" }>,
): string {
  switch (probe.kind) {
    case "ours":
      return "this account's equin";
    case "other-equin":
      return `the equin of another user account (uid ${probe.uid})`;
    case "foreign":
      return probe.holder ?? "a program of another user account";
  }
}

/**
 * When no gateway of ours is known to run: is the port answered anyway? By
 * this account's gateway (started outside this command) — say so, and stop;
 * by anything else — refuse, naming it: the port is this account's, and
 * moving it silently would break every bookmark and redirect URI.
 */
async function answeredByOurs(port: number): Promise<boolean> {
  const probe = await probeGateway(port);
  switch (probe.kind) {
    case "none":
      return false;
    case "ours":
      printRunning(
        "equin is already running (started outside this command).",
        port,
        [`port ${port} answers`],
      );
      return true;
    case "other-equin":
    case "foreign":
      throw new Error(
        `equin's port ${port} is taken by ${describeProbe(probe)}, so equin cannot start. ` +
          `Stop that program, or move equin with \`./equin start --port <${GATEWAY_PORT_RANGE.first}–${GATEWAY_PORT_RANGE.last}>\`.` +
          (probe.kind === "foreign"
            ? ""
            : ` (${(await portHolder(port)) ?? "no process of this account holds it"})`),
      );
  }
}

/** Record the port once the gateway answers on it, and say so when it is news. */
async function recordPort(plan: PortPlan): Promise<void> {
  await writeGatewayPortRecord(plan.record);
  if (plan.said !== null) console.log(plan.said);
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

function printRunning(headline: string, port: number, facts: string[]): void {
  console.log(headline);
  console.log(`  Its address: ${namespaceUrl(MAIN_WORKTREE_NAME, "", port)}`);
  details(...facts, `logs ${gatewayLogs.path}/`);
}

export default run;
