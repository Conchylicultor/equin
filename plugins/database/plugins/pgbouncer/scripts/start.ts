#!/usr/bin/env bun
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import {
  PGBOUNCER_PORT,
  PGBOUNCER_SOCKET_DIR,
  PGBOUNCER_CONFIG_FILE,
  PGBOUNCER_USERLIST_FILE,
  PGBOUNCER_LOG_FILE,
  PGBOUNCER_PID_FILE,
} from "../shared";

// Duplicated from embedded/shared — standalone scripts can't use @plugins
// aliases, and shared/ is plugin-private so cross-plugin imports are forbidden.
// The upstream port must honor EQUIN_PG_PORT so a preview's PgBouncer dials
// the same per-instance port its embedded PG bound (see embedded/shared paths.ts).
const PG_PORT = readEnv("PG_PORT") ? Number(readEnv("PG_PORT")) : 5433;
const PG_USER = "singularity";
const PG_SOCKET_DIR = PGBOUNCER_SOCKET_DIR; // same dir

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

// ─── config generation ──────────────────────────────────────

function writeConfig(): void {
  const ini = `[databases]
* = host=${PG_SOCKET_DIR} port=${PG_PORT}

[pgbouncer]
listen_addr =
unix_socket_dir = ${PGBOUNCER_SOCKET_DIR}
listen_port = ${PGBOUNCER_PORT}
pool_mode = transaction
max_client_conn = 200
default_pool_size = 16
min_pool_size = 5
auth_type = trust
auth_file = ${PGBOUNCER_USERLIST_FILE}
logfile = ${PGBOUNCER_LOG_FILE}
pidfile = ${PGBOUNCER_PID_FILE}
`;
  writeFileSync(PGBOUNCER_CONFIG_FILE, ini);
}

function writeUserlist(): void {
  writeFileSync(PGBOUNCER_USERLIST_FILE, `"${PG_USER}" ""\n`);
}

// ─── main lifecycle ─────────────────────────────────────────

async function main(): Promise<void> {
  const binary = resolveBinary();

  // Reattach: if PgBouncer is already running, nothing to do.
  if (existsSync(PGBOUNCER_PID_FILE) && (await pingSocket(1500))) {
    console.log("pgbouncer: already running; reattaching");
    return;
  }

  // Stale pidfile from a crashed prior run.
  if (existsSync(PGBOUNCER_PID_FILE)) {
    console.log("pgbouncer: removing stale pidfile");
    rmSync(PGBOUNCER_PID_FILE, { force: true });
  }

  // Generate config fresh each boot (idempotent).
  writeConfig();
  writeUserlist();

  console.log(
    `pgbouncer: starting (socket=${PGBOUNCER_SOCKET_DIR}, port=${PGBOUNCER_PORT})`,
  );
  const result = spawnSync(binary, [PGBOUNCER_CONFIG_FILE, "-d"], {
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const out = result.stderr?.toString() || result.stdout?.toString() || "";
    throw new Error(
      `pgbouncer start failed: ${out} (see ${PGBOUNCER_LOG_FILE})`,
    );
  }

  // Wait for socket readiness.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingSocket(500)) {
      console.log("pgbouncer: ready");
      return;
    }
    await Bun.sleep(300);
  }
  throw new Error(
    `pgbouncer: did not become ready within ${READY_TIMEOUT_MS}ms`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
