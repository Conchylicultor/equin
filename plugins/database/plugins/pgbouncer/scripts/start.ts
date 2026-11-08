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
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
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

// ─── main lifecycle ─────────────────────────────────────────

async function main(): Promise<void> {
  const binary = resolveBinary();

  // Reattach: if PgBouncer is already running, nothing to do. It keeps the
  // config of its own start; the first backend to boot converges it onto the
  // current one (`database/pgbouncer#machine`'s convergePgbouncerConfig).
  if (existsSync(PGBOUNCER_PID_FILE) && (await pingSocket(1500))) {
    console.log("pgbouncer: already running; reattaching");
    return;
  }

  // Stale pidfile from a crashed prior run.
  if (existsSync(PGBOUNCER_PID_FILE)) {
    console.log("pgbouncer: removing stale pidfile");
    rmSync(PGBOUNCER_PID_FILE, { force: true });
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

  // Wait for socket readiness.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (launched.exit !== null) {
      throw new Error(
        `pgbouncer exited (${launched.exit}) before it was ready (see ${PGBOUNCER_LOG_FILE})`,
      );
    }
    if (await pingSocket(500)) {
      console.log("pgbouncer: ready");
      return;
    }
    await Bun.sleep(300);
  }
  throw new Error(
    `pgbouncer: did not become ready within ${READY_TIMEOUT_MS}ms (see ${PGBOUNCER_LOG_FILE})`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
