#!/usr/bin/env bun
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  serviceLogTarget,
  type ServiceLogTarget,
} from "@plugins/infra/plugins/launcher/plugins/gateway-logs/core";
import { adoptLegacyLogSync } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import { adoptFd } from "@plugins/packages/plugins/owned-fd/core";
import { writeFileSync, rmSync } from "node:fs";
import {
  existsSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  judgePidFile,
  psProbeArgv,
  readPsProbe,
  type PidFileHolder,
  type PidFileRead,
} from "@plugins/packages/plugins/pid-file-holder/core";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import {
  PGBOUNCER_PORT,
  PGBOUNCER_SOCKET_DIR,
  PGBOUNCER_CONFIG_FILE,
  PGBOUNCER_USERLIST_FILE,
  PGBOUNCER_LOG_FILE,
  PGBOUNCER_LEGACY_LOG_FILE,
  PGBOUNCER_PID_FILE,
} from "../shared";
import { pgbouncerConfigFiles } from "../server";

const READY_TIMEOUT_MS = 30_000;
const PGBOUNCER_SOCKET = join(
  PGBOUNCER_SOCKET_DIR,
  `.s.PGSQL.${PGBOUNCER_PORT}`,
);

// ─── platform detection ──────────────────────────────────────

function platformPackage(): string {
  const mapping: Record<string, Record<string, string>> = {
    darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
    linux: { arm64: "linux-arm64", x64: "linux-x64" },
  };
  const pkg = mapping[process.platform]?.[process.arch];
  if (!pkg)
    throw new Error(
      `pgbouncer: unsupported platform ${process.platform}/${process.arch}`,
    );
  return `@equin/pgbouncer-${pkg}`;
}

// ─── binary resolution ──────────────────────────────────────

function resolveBinary(): string {
  // A packaged release points at the vendored native binary via env override.
  const override = readEnv("PGBOUNCER_BIN");
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `pgbouncer: ${envName("PGBOUNCER_BIN")} set to ${override} but that file does not exist`,
      );
    }
    return override;
  }
  const pluginRoot = dirname(import.meta.dir);
  const bin = join(
    pluginRoot,
    "node_modules",
    platformPackage(),
    "native",
    "bin",
    "pgbouncer",
  );
  if (!existsSync(bin)) {
    throw new Error(
      `pgbouncer: binary not found at ${bin}; run \`bun install\``,
    );
  }
  return bin;
}

// ─── socket probe ───────────────────────────────────────────

function pingSocket(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(PGBOUNCER_SOCKET);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ─── launch ─────────────────────────────────────────────────

/**
 * Start the daemon. With the gateway's log relay, PgBouncer runs in the
 * FOREGROUND (it logs to stderr only when not daemonized), detached into its
 * own session with stdout/stderr on the relay fd, and this script lets go of it
 * — so its log is the relay's bounded channel, and the config names no
 * `logfile`. It still writes its pidfile, which every stop and reattach reads.
 *
 * `absent` is a gateway older than the relay running this script (its binary is
 * only rebuilt by `./equin start`): PgBouncer daemonizes as before, with no log
 * at all — said out loud, never by quietly reviving the unbounded file.
 */
function launch(binary: string, target: ServiceLogTarget): Launched {
  if (target.kind === "relay") {
    const adopted = adoptLegacyLogSync(
      PGBOUNCER_LEGACY_LOG_FILE,
      PGBOUNCER_LOG_FILE,
    );
    if (adopted.kind === "moved")
      console.log(
        `pgbouncer: moved ${PGBOUNCER_LEGACY_LOG_FILE} to ${adopted.to}`,
      );
    if (adopted.kind === "slots-full")
      console.log(
        `pgbouncer: left ${PGBOUNCER_LEGACY_LOG_FILE} in place: every backup slot of ${PGBOUNCER_LOG_FILE} is taken`,
      );
    // The relay fd is this script's to close once PgBouncer holds its copies.
    const relay = adoptFd(target.fd);
    const child = spawn(binary, [PGBOUNCER_CONFIG_FILE], {
      detached: true,
      stdio: ["ignore", relay.fd, relay.fd],
    });
    relay.close();
    // A foreground daemon that dies at once (a config it refuses) says why on
    // the relay, not here: the readiness wait stops at its exit, naming the log.
    const launched: Launched = { exit: null };
    child.on("exit", (code, signal) => {
      launched.exit = signal ?? `code ${code}`;
    });
    child.unref();
    return launched;
  }
  console.log(
    "pgbouncer: this gateway predates the service log relay; running without a log — restart the gateway (./equin start --force) and then pgbouncer",
  );
  const result = spawnSync(binary, [PGBOUNCER_CONFIG_FILE, "-d"], {
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const out = result.stderr?.toString() || result.stdout?.toString() || "";
    throw new Error(`pgbouncer start failed: ${out}`);
  }
  // Daemonized: the -d parent's own exit is the success above.
  return { exit: null };
}

/** How the launched process ended, while the readiness wait runs; null while it lives. */
interface Launched {
  exit: string | null;
}

// ─── who holds the pidfile ──────────────────────────────────

/**
 * Who holds PgBouncer's pidfile, judged by the pid it names
 * (`packages/pid-file-holder`) — never by dialing the socket, which fails for
 * a PgBouncer that is only slow: reading that as "crashed" deleted a live
 * daemon's pidfile (so no stop or teardown could find it again) and started a
 * second one beside it. The daemon this script launches runs as this user
 * with its config file on its command line, so that process is PgBouncer.
 */
function pgbouncerHolder(file: PidFileRead | null): PidFileHolder {
  return judgePidFile(file, {
    uid: process.getuid!(),
    executable: "pgbouncer",
    argvMarker: PGBOUNCER_CONFIG_FILE,
    probe: (pid) => {
      const [cmd, ...args] = psProbeArgv(pid);
      const ps = spawnSync(cmd!, args, { encoding: "utf8" });
      if (ps.error) throw ps.error;
      return readPsProbe(pid, ps, Date.now());
    },
  });
}

/** The pidfile's text and mtime (stat after the read, so the mtime is never older than the text), or null when there is none. */
function readPidFile(): PidFileRead | null {
  try {
    const text = readFileSync(PGBOUNCER_PID_FILE, "utf-8");
    return { text, mtimeMs: statSync(PGBOUNCER_PID_FILE).mtimeMs };
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Wait for the socket to accept, failing if `exited` reports the daemon gone first. */
async function waitReady(exited: () => string | null): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit !== null) {
      throw new Error(
        `pgbouncer exited (${exit}) before it was ready (see ${PGBOUNCER_LOG_FILE})`,
      );
    }
    if (await pingSocket(500)) return;
    await Bun.sleep(300);
  }
  throw new Error(
    `pgbouncer: did not become ready within ${READY_TIMEOUT_MS}ms (see ${PGBOUNCER_LOG_FILE})`,
  );
}

// ─── main lifecycle ─────────────────────────────────────────

async function main(): Promise<void> {
  const binary = resolveBinary();

  const judged = readPidFile();
  const holder = pgbouncerHolder(judged);
  switch (holder.kind) {
    case "live":
      // Reattach. It keeps the config of its own start; the first backend to
      // boot converges it onto the current one (`database/pgbouncer#machine`'s
      // convergePgbouncerConfig). Alive is not answering: a socket that never
      // accepts fails the start, naming it — the daemon is left running.
      console.log(
        `pgbouncer: already running (pid ${holder.pid}); reattaching`,
      );
      await waitReady(() => null);
      return;
    case "absent":
      break;
    case "stale":
      // Only while the file still says what was judged, so a PgBouncer that
      // wrote it since is never the one unlinked.
      const now = readPidFile();
      if (now?.text !== judged!.text || now.mtimeMs !== judged!.mtimeMs) {
        throw new Error(
          `pgbouncer: ${PGBOUNCER_PID_FILE} changed while it was judged stale (${holder.why}); not removing it — re-run the start`,
        );
      }
      console.log(`pgbouncer: removing stale pidfile (${holder.why})`);
      rmSync(PGBOUNCER_PID_FILE, { force: true });
      break;
    case "foreign":
      throw new Error(
        `pgbouncer: ${PGBOUNCER_PID_FILE} names pid ${holder.pid}, a process of yours that is not PgBouncer (${holder.args}); not removing it. If no pgbouncer runs with ${PGBOUNCER_CONFIG_FILE}, remove the file and re-run the start`,
      );
    case "unreadable":
      throw new Error(
        `pgbouncer: ${PGBOUNCER_PID_FILE} names no pid (${JSON.stringify(holder.text.slice(0, 80))}); not removing it. If no pgbouncer runs with ${PGBOUNCER_CONFIG_FILE}, remove the file and re-run the start`,
      );
  }

  // Generate config fresh each boot (idempotent), from the lane table — the
  // same rendering every backend converges the running daemon onto.
  const { ini, userlist } = pgbouncerConfigFiles();
  writeFileSync(PGBOUNCER_USERLIST_FILE, userlist);
  writeFileSync(PGBOUNCER_CONFIG_FILE, ini);

  console.log(
    `pgbouncer: starting (socket=${PGBOUNCER_SOCKET_DIR}, port=${PGBOUNCER_PORT})`,
  );
  const launched = launch(binary, serviceLogTarget(process.argv));
  await waitReady(() => launched.exit);
  console.log("pgbouncer: ready");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
