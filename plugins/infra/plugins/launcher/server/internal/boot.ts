import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  worktreesDir,
  setReleaseIdentity,
  type ReleaseIdentity,
} from "@plugins/infra/plugins/paths/server";
import { DATABASE_CONFIG_PATH } from "@plugins/database/core";
import {
  ensureDatabase,
  getAdminPool,
} from "@plugins/database/plugins/admin/server";
import { writeWorktreeSpec } from "@plugins/infra/plugins/worktree/server";
import {
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { seedAssetMirrorCache } from "@plugins/infra/plugins/asset-mirror/server";
import { propagateOriginLayer } from "./config-propagate";
import { retryUntil, exponential } from "@plugins/packages/plugins/retry/core";
// Canonical embedded-cluster constants — the single source of truth for where
// PG/PgBouncer listen. Importing them (rather than re-deriving the paths here)
// keeps database.json's connection host in lockstep with where the embedded
// start scripts actually bind their sockets.
import {
  PG_SOCKET_DIR,
  PG_PORT,
  PG_USER,
  pgPostmasterPidFile,
} from "@plugins/database/plugins/embedded/server";
import {
  PGBOUNCER_SOCKET_DIR,
  PGBOUNCER_PORT,
  pgbouncerPidFileUnder,
} from "@plugins/database/plugins/pgbouncer/server";
import { dbConfigDir } from "@plugins/database/data-dirs";
import { userConfigRelativeToRoot } from "@plugins/config_v2/data-dirs";
import {
  CENTRAL_ROUTES_FILENAME,
  GATEWAY_PID_FILENAME,
  gatewayLocks,
  gatewayLogs,
  gatewayPidFileRelativeToRoot,
  gatewayState,
  socketsDir,
} from "../../data-dirs";
import { listenFlag } from "./listen";
// Own-plugin, so relative — the `@plugins/infra/plugins/launcher/core` alias
// would name this plugin from inside itself.
import { pickRuntimeEnv, runtimeEnvNames } from "../../core";
import { gatewayBinary } from "../../deps";
import { readyNow, type Ready } from "@plugins/infra/plugins/deps/deps";
import {
  builtFile,
  type BuildSource,
} from "@plugins/infra/plugins/deps/plugins/build/deps";

// Progress sink. The launcher runs in a CLI process whose human-facing output
// belongs on the terminal, but this plugin must not assume stdout (a packaged
// host may pipe progress elsewhere) — and plugin code may not call console.log.
// So callers inject the sink; bin/ commands pass `console.log`, others a no-op.
type LogFn = (msg: string) => void;
const noop: LogFn = () => {};

// All data paths derive from the (possibly overridden) SINGULARITY_DIR, so a
// release launched with SINGULARITY_DIR=<releaseRoot> isolates its entire install
// — pid file, logs, the PG cluster, the registry — under that root.
// The gateway owns the rotating per-channel logs under its log dir (gateway.log,
// <worktree>.log). This file only captures the daemon's raw stdout/stderr — Go
// panics and any crash before slog is wired up. Truncated on each start so it
// can't grow unbounded; the last crash survives until the next launch.
const GATEWAY_STDIO_LOG = gatewayLogs.file("gateway-stdio.log");
// The gateway's own rotating slog sink. Only ever read as a FALLBACK when the
// stdio log has nothing (see gatewayLogTail): it carries prior sessions too, so
// its tail may describe a boot that is not this one.
const GATEWAY_SLOG_LOG = gatewayLogs.file("gateway.log");

/**
 * Host preconditions the whole stack depends on, asserted before anything is
 * spawned or written. This is the home for them: each is a property of the
 * machine, knowable in microseconds, whose violation otherwise surfaces minutes
 * later as an unrelated downstream symptom (a socket ENOENT, a readiness
 * timeout). Add further preconditions here rather than letting them be
 * rediscovered at runtime.
 *
 * Today there is exactly one. Postgres' `initdb` refuses to run as the root OS
 * user, so as root the embedded cluster — and therefore every backend — cannot
 * start at all. This is not a corner case: the deploy plugin defaults `sshUser`
 * to "root" (plugins/apps/plugins/deploy/plugins/servers/server/internal/tables.ts)
 * and the Hetzner provider prose walks the operator into a root shell, so the
 * platform's own default deploy path lands them in the one account under which
 * the bundle cannot run.
 */
export function assertSupportedHost(): void {
  // `process.getuid` is undefined off POSIX; an absent uid cannot be root,
  // which is the only thing this check is about.
  if (process.getuid?.() === 0) {
    throw new Error(
      [
        "Refusing to run as root: Postgres' initdb refuses to run as the root OS user, so the embedded cluster (and every backend behind it) cannot start.",
        "Create a non-root user and run this as them, e.g.:",
        "  adduser --disabled-password --gecos '' singularity",
        "  chown -R singularity:singularity <bundle dir>",
        "  su - singularity -c '<bundle dir>/launch'",
      ].join("\n"),
    );
  }
}

/**
 * The last `lines` non-empty lines of a log file, or null when there is nothing
 * to quote. Absence is a legitimate state here — the gateway can die before it
 * opens a log — not a failure, so callers fall through to the next source;
 * every other read error propagates.
 */
function readLogTail(path: string, lines: number): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const kept = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-lines);
  return kept.length > 0 ? kept.join("\n") : null;
}

const GATEWAY_LOG_TAIL_LINES = 20;

/**
 * The gateway's last output, for embedding in a launcher error.
 *
 * `gateway-stdio.log` FIRST and by design: `spawnGatewayDaemon` opens it with
 * mode "w", so it is truncated on every start and holds exactly THIS boot's
 * output with no scrollback to read past — and the gateway writes its fatal
 * service-start error to stderr precisely so it lands there. The rotating
 * `gateway.log` is only the fallback: correct, but it also holds earlier
 * sessions, so its tail can describe a different boot.
 */
function gatewayLogTail(): string {
  const tail =
    readLogTail(GATEWAY_STDIO_LOG, GATEWAY_LOG_TAIL_LINES) ??
    readLogTail(GATEWAY_SLOG_LOG, GATEWAY_LOG_TAIL_LINES);
  return tail ?? `(no output in ${GATEWAY_STDIO_LOG} or ${GATEWAY_SLOG_LOG})`;
}

/**
 * The gateway pidfile under an arbitrary install root. Used by teardown to find a
 * preview's gateway (rooted at its `/tmp/sgp-XXXXXX` data dir, not the dev
 * data root). {@link pidFile} is the same path under this process's own root.
 *
 * The subpath comes from the `locks/gateway` declaration rather than being
 * spelled here — see `gatewayPidFileRelativeToRoot`'s docblock for why writing
 * it out a second time is how a preview's gateway becomes un-killable.
 */
export function gatewayPidFile(root: string): string {
  return join(root, gatewayPidFileRelativeToRoot());
}

/**
 * The gateway pidfile under THIS process's data root.
 *
 * Read straight off the `locks/gateway` declaration this plugin owns, rather
 * than by handing `gatewayPidFile` a root — the declaration IS the location, so
 * there is nothing to keep in step. A FUNCTION, not the module-level const it
 * used to be: that const froze the data root at first import, while the release
 * launcher sets it before importing anything path-dependent.
 */
function pidFile(): string {
  return gatewayLocks.file(GATEWAY_PID_FILENAME);
}

export function readPid(): number | null {
  try {
    const n = parseInt(readFileSync(pidFile(), "utf-8").trim(), 10);
    return isNaN(n) ? null : n;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // process exists but we can't signal it
    if (code === "ESRCH") return false; // process does not exist
    throw err;
  }
}

export async function isGatewayListening(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/gateway/worktrees`, {
      signal: AbortSignal.timeout(1000),
    });
    return resp.ok;
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- any network error (connection refused, timeout, DNS) means the gateway is not listening; propagating would misrepresent a probe failure as a fatal error
  } catch {
    return false;
  }
}

export function hasPgBouncerPackage(repoRoot: string): boolean {
  return existsSync(
    join(repoRoot, "plugins/database/plugins/pgbouncer/node_modules/@equin"),
  );
}

export function pgbouncerService(repoRoot: string) {
  return {
    name: "pgbouncer",
    start: [
      "bun",
      "run",
      join(repoRoot, "plugins/database/plugins/pgbouncer/scripts/start.ts"),
    ],
    ready: {
      unix: join(PGBOUNCER_SOCKET_DIR, `.s.PGSQL.${PGBOUNCER_PORT}`),
    },
    watchdog: { intervalSec: 2 },
  };
}

export function pgbouncerConnection() {
  return { host: PGBOUNCER_SOCKET_DIR, port: PGBOUNCER_PORT };
}

export function ensureDatabaseConfig(
  repoRoot: string,
  log: LogFn = noop,
): void {
  // Upgrade existing config: add pgbouncer service if packages are now installed.
  if (existsSync(DATABASE_CONFIG_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(DATABASE_CONFIG_PATH, "utf-8"));
      const services: Array<{ name: string }> = existing.services ?? [];
      const hasPgBouncer = services.some((s) => s.name === "pgbouncer");
      let changed = false;
      let nextServices = services;
      if (!hasPgBouncer && hasPgBouncerPackage(repoRoot)) {
        existing.pgbouncer = pgbouncerConnection();
        nextServices = [...nextServices, pgbouncerService(repoRoot)];
        changed = true;
        log("Updated database config: added PgBouncer");
      }
      if (changed) {
        existing.services = nextServices;
        writeFileSync(
          DATABASE_CONFIG_PATH,
          JSON.stringify(existing, null, 2) + "\n",
        );
      }
    } catch (err) {
      if (err instanceof SyntaxError) return;
      throw err;
    }
    return;
  }

  const embeddedPkgDir = join(
    repoRoot,
    "plugins/database/plugins/embedded/node_modules/@embedded-postgres",
  );
  const hasEmbedded = existsSync(embeddedPkgDir);
  const hasPgBouncer = hasEmbedded && hasPgBouncerPackage(repoRoot);

  const startScript = join(
    repoRoot,
    "plugins/database/plugins/embedded/scripts/start.ts",
  );

  const config = hasEmbedded
    ? {
        provider: "embedded" as const,
        connection: {
          host: PG_SOCKET_DIR,
          port: PG_PORT,
          user: PG_USER,
        },
        ...(hasPgBouncer ? { pgbouncer: pgbouncerConnection() } : {}),
        services: [
          {
            name: "postgres",
            start: ["bun", "run", startScript],
            ready: {
              unix: join(PG_SOCKET_DIR, `.s.PGSQL.${PG_PORT}`),
            },
            watchdog: { intervalSec: 2 },
          },
          ...(hasPgBouncer ? [pgbouncerService(repoRoot)] : []),
        ],
      }
    : {
        provider: "system" as const,
        connection: {
          host: "localhost",
          port: 5432,
          user: process.env.USER ?? "postgres",
        },
        services: [],
      };

  dbConfigDir.ensure();
  writeFileSync(DATABASE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  log(
    hasEmbedded
      ? `Generated database config (embedded Postgres${hasPgBouncer ? " + PgBouncer" : ""})`
      : "Generated database config (system Postgres)",
  );
}

/**
 * Write a release `database.json`: the SAME `DatabaseConfig` shape as
 * `ensureDatabaseConfig`'s embedded path, but with each service's `start` argv
 * pointing at a compiled start binary instead of `["bun","run",<startScript.ts>]`.
 * A packaged release has no bun and no node_modules, so the dev probe + the
 * `bun run` invocation don't apply — the compiled `pg-start` / `pgbouncer-start`
 * binaries resolve the vendored native PG/PgBouncer instead.
 *
 * The `connection` / `pgbouncer` blocks and the `ready` socket probes are
 * identical to the embedded case (same canonical PG_* / PGBOUNCER_* constants),
 * so a release cluster is indistinguishable to the gateway from a dev embedded
 * one — only the spawn command differs. PgBouncer is included only when a start
 * binary is supplied.
 */
export function writeReleaseDatabaseConfig(
  opts: { pgStartBin: string; pgbouncerStartBin?: string },
  log: LogFn = noop,
): void {
  const { pgStartBin, pgbouncerStartBin } = opts;
  const hasPgBouncer = pgbouncerStartBin !== undefined;

  const config = {
    provider: "embedded" as const,
    connection: {
      host: PG_SOCKET_DIR,
      port: PG_PORT,
      user: PG_USER,
    },
    ...(hasPgBouncer ? { pgbouncer: pgbouncerConnection() } : {}),
    services: [
      {
        name: "postgres",
        start: [pgStartBin],
        ready: {
          unix: join(PG_SOCKET_DIR, `.s.PGSQL.${PG_PORT}`),
        },
        watchdog: { intervalSec: 2 },
      },
      ...(hasPgBouncer
        ? [
            {
              name: "pgbouncer",
              start: [pgbouncerStartBin],
              ready: {
                unix: join(PGBOUNCER_SOCKET_DIR, `.s.PGSQL.${PGBOUNCER_PORT}`),
              },
              watchdog: { intervalSec: 2 },
            },
          ]
        : []),
    ],
  };

  dbConfigDir.ensure();
  writeFileSync(DATABASE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  log(
    `Generated release database config (embedded Postgres${hasPgBouncer ? " + PgBouncer" : ""})`,
  );
}

/**
 * The gateway sealed into the release bundle at `bundleRoot` — read from its
 * `deps.sealed.json`, never built: a release host has no Go toolchain and no
 * source. Throws when the bundle does not carry a gateway for this platform.
 */
export async function bundledGateway(
  bundleRoot: string,
): Promise<Ready<BuildSource>> {
  const now = await readyNow(gatewayBinary, { root: bundleRoot });
  if (now.kind === "ready") return now.ready;
  throw new Error(
    `The bundle at ${bundleRoot} has no usable gateway (${gatewayBinary.id}: ${now.kind}${now.kind === "failed" ? ` — ${now.message}` : ""}).`,
  );
}

/** What a gateway launch needs, whoever performs it (see {@link gatewayLaunchSpec}). */
export interface GatewayLaunchOptions {
  /**
   * The installed gateway binary (`gateway-binary`): ensured from the checkout
   * by `./singularity start` / `serve-app`, read from the bundle by a release.
   * A `Ready`, so a launch that never ensured one does not compile.
   */
  gateway: Ready<BuildSource>;
  /**
   * The gateway's working directory, which its supervised children inherit: the
   * checkout whose scripts `database.json` runs. Those start as `bun run <script>`,
   * and `bun` is a mise shim that resolves its version from the cwd's
   * `mise.toml` — so a cwd outside the checkout (the binary's own deps-cache dir)
   * leaves Postgres unable to start and the gateway exiting at boot.
   */
  cwd: string;
  port: number;
  /**
   * Bind host, e.g. `127.0.0.1`. Omitted (the default) is a wildcard bind on
   * every interface — dev and the desktop app, where the gateway IS the front
   * door. A deployment passes loopback, so it is reachable only through the TLS
   * reverse proxy in front of it: the public-port hole stops being something a
   * firewall rule has to remember and becomes a property of how it was started.
   */
  bindHost?: string;
  logLevel: string;
  /**
   * Fallback namespace for subdomain-less requests, passed as
   * `-default-namespace`. Set to the single app's name in a packaged build so a
   * desktop webview at bare localhost reaches the backend; omitted in dev (such
   * requests 404, today's behavior).
   */
  defaultNamespace?: string;
}

/**
 * How to run the gateway — argv, working dir, environment, and where its raw
 * stdio goes — as data. The ONE derivation of a gateway launch: the detached
 * spawn ({@link spawnGatewayDaemon}) and the launchd job `./singularity start`
 * registers on macOS (`login-service.ts`) are both rendered from it, so the two
 * ways the gateway gets started cannot drift apart.
 *
 * The gateway starts from the DECLARED runtime environment, not from ours:
 * `pickRuntimeEnv(process.env)` keeps only the names `launcher/core` declares.
 * Whatever else the starting shell carries — an agent's
 * `SINGULARITY_CONVERSATION_ID`, its `CLAUDE_*` — stays here instead
 * of reaching every backend on the host. `-child-env` hands the gateway the same
 * list of names, and the gateway forwards only those to the backends and
 * Postgres / PgBouncer it starts.
 *
 * `env` is computed from the LIVE `process.env`. Bun snapshots the real
 * environment at process start, so runtime mutations to `process.env` (the
 * release launcher's `SINGULARITY_DIR`, PG bin-dir and other relocation
 * overrides, set in launch.ts before any import, and the release identity
 * stamped by `bootSelfContainedApp`) would NOT reach an implicitly inherited
 * env. Filtering the live object keeps them, because each is a forwarded name:
 * the gateway re-roots its registry / sockets / cluster dirs under the release
 * dir and hands the rest to the supervised start binaries and the backend. The
 * `-listen <bindHost>:<port>` flag pins the listen address.
 */
export function gatewayLaunchSpec(opts: GatewayLaunchOptions): {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The raw stdout/stderr capture (Go panics, pre-slog crashes). */
  stdioLog: string;
  logsDir: string;
} {
  const logsDir = gatewayLogs.ensure();
  gatewayState.ensure();
  gatewayLocks.ensure();
  return {
    argv: [
      builtFile(opts.gateway),
      "-listen",
      listenFlag({ host: opts.bindHost ?? null, port: opts.port }),
      "-log-level",
      opts.logLevel,
      // EVERY path the gateway reads or writes is passed explicitly, from the
      // declaration that owns it. The Go side has its own defaults derived from
      // the inherited SINGULARITY_DIR, and they are kept in step (gateway/main.go)
      // — but a default is a SECOND derivation of this layout, and a second
      // derivation is what silently keeps writing to the old spot when the
      // layout moves. Passing them means the declaration is the only authority.
      "-log-dir",
      logsDir,
      "-registry-dir",
      worktreesDir(),
      "-sockets-dir",
      // The one flag with an env arm: a release stages its data root at a long
      // versioned path, which would blow the 104-byte AF_UNIX cap, so `launch.ts`
      // reroots the backend sockets onto a short /tmp dir via this var. Reading
      // it here keeps that escape hatch working now that the flag is explicit —
      // passing the declaration unconditionally would override it.
      process.env.SINGULARITY_SOCKETS_DIR ?? socketsDir.path,
      "-central-routes-file",
      gatewayState.file(CENTRAL_ROUTES_FILENAME),
      "-db-config",
      DATABASE_CONFIG_PATH,
      // The gateway records its own pid: under launchd no launcher sees the
      // spawn, and a generation launchd relaunched would otherwise leave the
      // file naming a dead one.
      "-pid-file",
      pidFile(),
      ...(opts.defaultNamespace
        ? ["-default-namespace", opts.defaultNamespace]
        : []),
      // Which of its own variables the gateway may hand its children. Required
      // by the gateway, and the same declaration as `env` below, so the two
      // boundaries (us → gateway, gateway → child) cannot disagree.
      "-child-env",
      runtimeEnvNames().join(","),
    ],
    // Nothing the gateway reads is relative (every path is a flag above), but
    // its children resolve their toolchain from it — see `cwd` above.
    cwd: opts.cwd,
    // The declared subset of the LIVE `process.env` — never an implicit
    // inherit (which would miss the release launcher's mutations) and never
    // the whole thing (which hands the starter's shell to every backend).
    env: pickRuntimeEnv(process.env),
    stdioLog: GATEWAY_STDIO_LOG,
    logsDir,
  };
}

/**
 * Daemonize the gateway: spawn it detached (`unref()`), write its pid to the pid
 * file, and return the handle. The launch itself is {@link gatewayLaunchSpec}.
 */
export function spawnGatewayDaemon(opts: GatewayLaunchOptions): Bun.Subprocess {
  const spec = gatewayLaunchSpec(opts);
  // Truncate ("w"): only holds raw stdout/stderr until slog takes over, plus
  // any panic. The gateway writes its own rotating logs under -log-dir.
  const logFd = openSync(spec.stdioLog, "w");

  const gw = Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    stdout: logFd,
    stderr: logFd,
    stdin: "ignore",
    env: spec.env,
  });

  closeSync(logFd);
  // Written here too, not only by the gateway's own -pid-file: a gateway that
  // dies before it gets that far must still leave its (dead) pid behind, or a
  // preview's reaper — which reads a missing file as "still booting" — would
  // wait on it forever. The gateway then rewrites the same value.
  writeFileSync(pidFile(), String(gw.pid) + "\n");
  // Detached by default: `./singularity start` on a host without launchd and
  // the preview/desktop bring-up paths all outlive their launcher. A caller
  // that means to SUPERVISE the gateway (the release launcher under systemd)
  // calls `.ref()` on the returned handle and awaits `.exited`, which is why
  // the handle — not just the pid — is what this returns.
  gw.unref();
  return gw;
}

/**
 * Wait for a stopped process to be gone, bounded to the gateway's own 15s
 * shutdown budget plus launchd's margin (the job's ExitTimeOut is 20s). Throws
 * if it outlives that.
 *
 * A stop must be observed, not assumed: a fixed sleep let an old gateway keep
 * tearing down its backends while the new one booted and ran its orphan
 * reconcile — overlapping generations, the routine trigger for orphaned
 * backends.
 */
export async function awaitProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (isRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (isRunning(pid)) {
    throw new Error(
      `Process ${pid} is still running 20s after being stopped; refusing to carry on as if it were gone.`,
    );
  }
}

/** SIGTERM a process and {@link awaitProcessGone | wait for it to be gone}. */
export async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // Exited between the caller's liveness check and the signal.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  await awaitProcessGone(pid);
}

// Generous: the gateway does not bind its listener until its supervisor has
// brought EVERY managed service up (StartAll precedes ListenAndServe), and a
// cold `initdb` on a fresh host legitimately takes tens of seconds. Nothing
// waits this out in the failure case: the per-tick pid check below turns a
// gateway that died into an immediate throw, so the deadline only covers the
// narrow "alive but never listened" hang.
const GATEWAY_READY_TIMEOUT_MS = 120_000;

/**
 * Block until the gateway is serving, failing FAST and with the real reason if
 * it is not going to.
 *
 * The gateway exits non-zero when a managed service fails to start, so "the
 * gateway is listening" implies "every managed service came up" — which makes
 * this the one place the whole stack's startup can be gated. Polling only for
 * the listener (or worse, for the PG socket downstream) converts a precise
 * diagnosis emitted at t=0 into an unrelated timeout at t=90s; checking the pid
 * on every tick converts it back.
 */
export async function awaitGatewayReady(opts: {
  pid: number;
  port: number;
}): Promise<void> {
  const { pid, port } = opts;
  await retryUntil(
    async () => {
      // Death check FIRST, every tick — this is the case worth reporting fast,
      // and its evidence (the gateway's own last output) is already on disk.
      if (!isRunning(pid)) {
        throw new Error(
          `Gateway exited during startup (PID ${pid}). Last output:\n${gatewayLogTail()}`,
        );
      }
      return (await isGatewayListening(port)) ? true : null;
    },
    {
      delay: exponential({ initial: 100, max: 1_000 }),
      deadline: GATEWAY_READY_TIMEOUT_MS,
      onDeadline: () => {
        throw new Error(
          `Gateway (PID ${pid}) is running but never listened on port ${port} within ${GATEWAY_READY_TIMEOUT_MS}ms. Last output:\n${gatewayLogTail()}`,
        );
      },
    },
  );
}

/**
 * The supervisor's recorded failure reason for a managed service, or null when
 * there is none to report. `ServiceSnapshot.error` is populated only for a
 * failed service, so a healthy one legitimately has no `error` field.
 *
 * Called ONLY while composing an error that is about to be thrown, so it never
 * throws itself: an unreachable gateway, a non-200, or a snapshot without
 * `error` all mean "nothing to add here" — never a failure a caller could act
 * on. Letting a probe failure escape would replace a real diagnosis with a
 * worse one.
 */
async function readServiceError(
  port: number,
  service: string,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `http://localhost:${port}/gateway/services/${service}/status`,
      { signal: AbortSignal.timeout(1000) },
    );
    if (!resp.ok) return null;
    const snapshot = (await resp.json()) as { error?: unknown };
    return typeof snapshot.error === "string" && snapshot.error !== ""
      ? snapshot.error
      : null;
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- enrichment-only probe on an error path (same precedent as isGatewayListening): any network/parse error means the gateway has nothing to add to the error already being thrown
  } catch {
    return null;
  }
}

// Generous: a preview's PG is a from-scratch `initdb` running ALONGSIDE the full
// dev stack (CPU/IO contention), so the cold cluster-create path can exceed 30s.
// This launcher constant is release/preview-only — distinct from the database
// plugin's own `awaitPgReady`, so dev boot is unaffected.
const PG_READY_TIMEOUT_MS = 90_000;

/**
 * Poll the admin pool (`SELECT 1`) until PG is reachable, to a ~90s deadline.
 * The admin pool connects DIRECT to PG (5433 socket), independent of PgBouncer,
 * so this gates on the cluster being up before any DB is created. Fails loud on
 * deadline.
 *
 * Pass `port` (the gateway's) so the deadline path can quote the supervisor's
 * recorded reason. That covers the residual case `awaitGatewayReady` cannot:
 * the gateway came up — so every managed service DID start — and PG died
 * afterwards, which is a watchdog concern the gateway deliberately survives.
 */
export async function awaitPgReady(
  opts: { deadlineMs?: number; port?: number } = {},
): Promise<void> {
  const deadlineMs = opts.deadlineMs ?? PG_READY_TIMEOUT_MS;
  let lastErr: unknown = null;
  await retryUntil(
    async () => {
      try {
        await getAdminPool().query("SELECT 1");
        return true;
        // eslint-disable-next-line promise-safety/no-absorbed-failure -- retryUntil probe: null signals "not ready yet, retry" (lastErr captured for the deadline); a genuine failure surfaces when the retry deadline elapses
      } catch (err) {
        lastErr = err;
        return null;
      }
    },
    {
      delay: exponential({ initial: 100, max: 1_000 }),
      deadline: deadlineMs,
      // Async: `retryUntil` returns whatever `onDeadline` returns, and its own
      // result is awaited by us — so the rejection propagates as a throw.
      onDeadline: async () => {
        const supervisorErr =
          opts.port === undefined
            ? null
            : await readServiceError(opts.port, "postgres");
        throw new Error(
          `Postgres did not become reachable within ${deadlineMs}ms` +
            (supervisorErr === null
              ? ""
              : `; gateway supervisor reports: ${supervisorErr}`),
          { cause: lastErr },
        );
      },
    },
  );
}

// Generous: a release provisions its DB by create-empty-then-migrate, so the
// very first boot runs the entire migration set from scratch (a fork would copy
// an already-migrated DB). That cold path, plus pool warmup and derived-view
// rebuild behind the onReadyBlocking barrier, can take well over 30s.
const HEALTH_READY_TIMEOUT_MS = 120_000;

/**
 * Poll `http://<name>.localhost:<port>/api/health/ready` until it returns 200.
 * The gateway only reports a backend ready once its onReadyBlocking barrier
 * (migrations + warmup) completes, so a 200 here means the app DB is migrated
 * and the backend is serving. A 404 means the gateway has no such namespace yet
 * (spec not picked up) — kept distinct from ready so we never false-positive on
 * an unknown-namespace gateway 404. Fails loud on deadline.
 */
async function awaitAppReady(name: Namespace, port: number): Promise<void> {
  // A packaged app listens on its own port, not the dev gateway's.
  const url = namespaceUrl(name, "/api/health/ready", port);
  let lastErr: unknown = null;
  await retryUntil(
    async () => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) return true;
        lastErr = new Error(`health/ready returned ${resp.status}`);
        return null;
        // eslint-disable-next-line promise-safety/no-absorbed-failure -- retryUntil probe: null signals "not ready yet, retry" (lastErr captured for the deadline); a genuine failure surfaces when the retry deadline elapses
      } catch (err) {
        lastErr = err;
        return null;
      }
    },
    {
      delay: exponential({ initial: 100, max: 1_000 }),
      deadline: HEALTH_READY_TIMEOUT_MS,
      onDeadline: () => {
        throw new Error(
          `App "${name}" did not become ready at ${url} within ${HEALTH_READY_TIMEOUT_MS}ms`,
          { cause: lastErr },
        );
      },
    },
  );
}

/**
 * Boot a packaged app's full runtime end to end, race-free. The launcher is a
 * release entry point invoked with SINGULARITY_DIR already set in its env (all
 * path constants are import-time frozen, so it cannot be set mid-process).
 *
 * Ordering (each step gates the next):
 *   1. (The caller hands in the gateway binary — ensured or sealed.)
 *   2. ensureDatabaseConfig — write the release database.json under the root.
 *   3. Spawn the gateway daemon (receives SINGULARITY_DIR and the rest of the
 *      declared runtime environment, listens on `port`);
 *      the gateway is the sole supervisor of embedded PG + PgBouncer.
 *   4. awaitGatewayReady — the gateway is serving, which (because it exits on a
 *      failed service start) means every managed service came up. Gating here
 *      rather than on the PG socket is what makes a service that refused to
 *      start surface as itself instead of as a downstream timeout.
 *   5. awaitPgReady — poll the admin pool until the cluster is up.
 *   6. ensureDatabase(name) — CREATE DATABASE if absent (idempotent).
 *   7. writeWorktreeSpec — written LAST, so the gateway only discovers the app
 *      after its DB exists; the spawned backend migrates the empty DB on boot.
 *   8. awaitAppReady — poll health/ready until the backend serves.
 */
export async function bootSelfContainedApp(opts: {
  name: Namespace;
  /** The gateway binary: `bundledGateway(bundleRoot)` in a release, `ensureDep` from a CLI. */
  gateway: Ready<BuildSource>;
  server: string;
  web: string;
  port: number;
  /** Gateway bind host; omitted is a wildcard bind. See `spawnGatewayDaemon`. */
  bindHost?: string;
  /**
   * Which build this is (from the bundle's `RELEASE.json`), stamped into the env
   * before the gateway spawn so it reaches the backend and `/api/health` can
   * name the serving build. Omitted outside a release.
   */
  releaseIdentity?: ReleaseIdentity;
  repoRoot: string;
  /**
   * Explicit backend spawn argv (e.g. `["<abs>/server"]` for a compiled
   * release). Threaded into spec.json; absent in dev, where the gateway
   * falls back to `bun bin/index.ts`.
   */
  command?: string[];
  /**
   * Which composition this app IS, threaded into the spec so the backend selects
   * its plugin registry by identity.
   *
   * Inert for a real release, whose `command` is a compiled binary: `release`
   * repoints the `@composition-server-registry` alias at compile time, so the
   * bundled closure IS the composition closure and there is no runtime selection
   * left to steer. It matters for the uncompiled path (`serve-app` with no
   * `--command`, which runs the checkout's `bun bin/index.ts`), and it is worth
   * recording either way: the spec is the one durable statement of which app a
   * namespace serves.
   */
  composition?: string;
  logLevel?: string;
  log?: LogFn;
}): Promise<{ gateway: Bun.Subprocess }> {
  const { name, server, web, command, composition, port, bindHost, repoRoot } =
    opts;
  const logLevel = opts.logLevel ?? "info";
  const log = opts.log ?? noop;

  ensureDatabaseConfig(repoRoot, log);
  // Stamp the release identity BEFORE the gateway spawn: a child's env is
  // snapshotted at spawn, and the backend gets its env from the gateway (both
  // names are forwarded names of the declared runtime environment), so this is
  // the last moment it can still reach the process that serves /api/health.
  if (opts.releaseIdentity) setReleaseIdentity(opts.releaseIdentity);
  // A self-contained app is single-namespace: route subdomain-less requests
  // (the desktop webview, single-origin web) to it via the gateway default.
  const gateway = spawnGatewayDaemon({
    gateway: opts.gateway,
    cwd: repoRoot,
    port,
    bindHost,
    logLevel,
    defaultNamespace: name,
  });
  const pid = gateway.pid;
  log(`Gateway started (PID ${pid}); waiting for it to serve...`);

  await awaitGatewayReady({ pid, port });
  log("Gateway is serving; waiting for Postgres...");

  await awaitPgReady({ port });
  await ensureDatabase(name);

  // Spec last: the gateway's fsnotify watcher only discovers the namespace once
  // its DB exists, so the backend's boot migrator never races DB creation.
  writeWorktreeSpec({
    name,
    server,
    web,
    command,
    composition,
  });
  log(`Registered app "${name}"; waiting for backend to become ready...`);

  await awaitAppReady(name, port);

  return { gateway };
}

/** Read a numeric PID from the first line of a pidfile; null if absent/invalid. */
function readPidFile(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const first = raw.split("\n", 1)[0]?.trim() ?? "";
  const n = parseInt(first, 10);
  return Number.isNaN(n) ? null : n;
}

/** Signal a pid, treating "already gone" (ESRCH) as success. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/**
 * Best-effort kill of whatever process is LISTENing on `port`. A teardown backstop
 * for processes detached into their own session (the gateway via `unref()`, PG via
 * `pg_ctl` fork+setsid) that a pidfile read might miss. `lsof` exits status 1 when
 * nothing matches — the expected "nothing to kill" case.
 */
function killListenerOnPort(port: number): void {
  let out: string;
  try {
    out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
  } catch (err) {
    if ((err as { status?: number }).status === 1) return; // no listener
    throw err;
  }
  for (const pid of out.split("\n").filter(Boolean)) {
    signalPid(Number(pid), "SIGTERM");
  }
}

const GATEWAY_STOP_TIMEOUT_MS = 10_000;

/**
 * Tear down a self-contained app stack rooted at `root` (a preview's `/tmp/sgp-*`
 * data dir). The whole stack is detached after boot — the gateway is `unref()`'d
 * into its own session, `pg_ctl` fork+setsids PG, and `pgbouncer -d` daemonizes —
 * so none sit in a killable process group. We kill each via its pidfile under
 * `root`, in a watchdog-safe order:
 *
 *   1. Gateway FIRST: SIGTERM and wait for exit. This stops the gateway's service
 *      watchdog (which would otherwise restart PG/PgBouncer on their ~2s probe) AND
 *      triggers the gateway's graceful shutdown, which kills the app backend.
 *      Backstop: killListenerOnPort(httpPort).
 *   2. PgBouncer: SIGTERM (Unix-socket-only — no TCP port to backstop).
 *   3. Postgres: SIGQUIT (immediate shutdown — the data dir is discarded, so no
 *      graceful drain is needed). Backstop: killListenerOnPort(pgPort) — PG
 *      TCP-binds the loopback override port.
 *
 * Idempotent: a missing pidfile or already-dead process is a no-op, so it is safe
 * to call on an orphan stack or twice on the same one. `httpPort`/`pgPort` are the
 * port backstops; omit them (e.g. an orphan-dir sweep where the ports are unknown)
 * to rely on the pidfiles alone.
 */
export async function teardownSelfContainedApp(
  opts: { root: string; httpPort?: number; pgPort?: number },
  log: LogFn = noop,
): Promise<void> {
  const { root, httpPort, pgPort } = opts;

  // 1. Gateway — kill and wait, so the supervisor watchdog is gone before we touch
  // PG/PgBouncer (else it would restart them out from under us).
  const gwPid = readPidFile(gatewayPidFile(root));
  if (gwPid !== null && isRunning(gwPid)) {
    signalPid(gwPid, "SIGTERM");
    await retryUntil(async () => (isRunning(gwPid) ? null : true), {
      delay: exponential({ initial: 50, max: 500 }),
      deadline: GATEWAY_STOP_TIMEOUT_MS,
      onDeadline: () => {
        signalPid(gwPid, "SIGKILL");
        return true;
      },
    });
  }
  if (httpPort !== undefined) killListenerOnPort(httpPort);

  // 2. PgBouncer.
  const pgbPid = readPidFile(pgbouncerPidFileUnder(root));
  if (pgbPid !== null) signalPid(pgbPid, "SIGTERM");

  // 3. Postgres — immediate shutdown; the cluster is thrown away.
  const pgPid = readPidFile(pgPostmasterPidFile(root));
  if (pgPid !== null) signalPid(pgPid, "SIGQUIT");
  if (pgPort !== undefined) killListenerOnPort(pgPort);

  log(`Tore down self-contained app at ${root}`);
}

/**
 * Seed the release bundle's pre-warmed asset-mirror cache into the app-data dir
 * on first run (copy-if-absent). A launcher boot step so `launch.ts` — a bin
 * entrypoint that must defer every path-dependent import past the env freeze and
 * may only reach other plugins through this barrel it already dynamic-imports
 * (the boundary rules forbid a literal cross-plugin dynamic import) — can trigger
 * it. The `asset-mirror` subdir name + the copy mechanics live in asset-mirror;
 * this only forwards.
 */
export function seedReleaseAssetMirror(opts: {
  bundleRoot: string;
  dataDir: string;
  log?: LogFn;
}): void {
  seedAssetMirrorCache(opts);
}

/**
 * Propagate the release bundle's resolved config origins into the app-data dir
 * on EVERY boot, so a released app's config-backed defaults are the ones THIS
 * bundle was built from — not the ones some earlier bundle happened to install
 * first. A host's data dir outlives every deploy (that is what makes the DB and
 * the user's settings survive a ship), so anything installed "on first run" is
 * installed once, ever.
 *
 * `release.ts` vendored the propagated seed under
 * `<bundleRoot>/config-seed/config/<worktree>/…`; this syncs it onto the user
 * config layer under `<dataDir>`, the exact path config_v2's config-dir.ts
 * reads. What is and is not written — the build-owned origin layer only, and why
 * a directory-level copy silently served a stale app — is
 * {@link propagateOriginLayer}'s to state.
 *
 * The destination comes from config_v2's OWN declaration, via
 * `userConfigRelativeToRoot()` — the dir has to be named under a foreign root
 * (a fresh install's data dir, not this process's), which is the same problem
 * `assetMirrorRelativeToRoot()` solves. It was inlined as `config/<worktree>`
 * with a comment asking a human to keep it in lockstep with `config-dir.ts`,
 * and the layout migration is exactly the change that would have broken that
 * lockstep silently: the seed would land at the old path while the app read the
 * new one, and a released app would fall back to hardcoded schema defaults with
 * nothing to fail. Note `@plugins/config_v2/data-dirs` is safe to import here
 * where the config_v2 BARRELS are not: a `data-dirs` module reaches `paths/core`
 * and nothing else, while the barrels reach `fields/core` → React. The launcher
 * boots a released app with no repo around it, so its import closure is kept
 * deliberately small. Once a DOM-free `tools` tsconfig made that a compile
 * error; the repo builds one full-lib program now, so it is intent to hold to
 * (research/2026-09-18-global-type-check-one-program.md).
 *
 * The bundle's own `config-seed/config/` layout is the release CLI's staging
 * convention, unrelated to the data root, so it stays spelled out.
 */
export function propagateReleaseConfig(opts: {
  bundleRoot: string;
  dataDir: string;
  worktreeName: string;
  log?: LogFn;
}): void {
  const src = join(opts.bundleRoot, "config-seed", "config", opts.worktreeName);
  const dest = join(
    opts.dataDir,
    userConfigRelativeToRoot(),
    opts.worktreeName,
  );
  if (!existsSync(src)) return; // dev / no seed baked → no-op

  const { written, removed } = propagateOriginLayer(src, dest);
  if (written > 0 || removed > 0) {
    opts.log?.(
      `Propagated config origins → ${dest} (${written} written, ${removed} removed)`,
    );
  }
}
