#!/usr/bin/env bun
/**
 * Embedded Postgres lifecycle script. Invoked by the gateway's generic
 * service supervisor via the "start" command in database.json.
 *
 * Handles: binary resolution, dylib symlinks, reattach detection,
 * initdb, stale pidfile cleanup, pg_ctl start, and the base database.
 *
 * Exits 0 on success (PG is running), non-zero on failure.
 */
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { Client } from "pg";
import {
  PG_PORT,
  PG_USER,
  PG_BASE_DATABASE,
  PG_DIR,
  PG_DATA_DIR,
  PG_SOCKET_DIR,
  PG_LOG_FILE,
  PG_PID_FILE,
  MAX_CONNECTIONS,
} from "../shared";

const READY_TIMEOUT_SEC = 30;

// ─── run user ────────────────────────────────────────────────

/**
 * Refuse to run as root, at the boundary and by name.
 *
 * `initdb` and `postgres` both refuse uid 0 themselves, so the run user has
 * always been load-bearing — but that refusal arrives as Postgres's own message
 * from deep inside a `spawnSync`, several layers below whoever chose the user,
 * and it says nothing about what the right user *is*. This check exists so the
 * failure names the concept instead: a deployment runs as its derived service
 * user, never root, and there is no field anywhere to set it to root.
 */
function assertNotRoot(): void {
  if (process.getuid?.() !== 0) return;
  throw new Error(
    [
      "pg: refusing to run as root (uid 0).",
      "",
      "Postgres will not initdb or start as root, so the whole stack must run as an",
      "unprivileged user. A deployed composition runs as the service user converge",
      "derives from its name (`svc-<composition>`, applied by the systemd unit's",
      "`User=` line); in dev it runs as you.",
      "",
      "If you got here via sudo, drop it. If via a systemd unit, that unit is missing",
      "its `User=`.",
    ].join("\n"),
  );
}

// ─── platform detection ──────────────────────────────────────

function platformPackage(): string {
  const platform = process.platform;
  const arch = process.arch;
  const mapping: Record<string, Record<string, string>> = {
    darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
    linux: { arm64: "linux-arm64", x64: "linux-x64" },
  };
  const pkg = mapping[platform]?.[arch];
  if (!pkg) throw new Error(`pg: unsupported platform ${platform}/${arch}`);
  return `@embedded-postgres/${pkg}`;
}

// ─── binary resolution ──────────────────────────────────────

function resolveBinDir(): string {
  // A packaged release points at vendored native binaries via env override.
  const override = readEnv("PG_BIN_DIR");
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `pg: ${envName("PG_BIN_DIR")} set to ${override} but that directory does not exist`,
      );
    }
    return override;
  }
  const pluginRoot = join(dirname(import.meta.dir)); // scripts/ -> embedded plugin root
  const pkg = platformPackage();
  const dir = join(pluginRoot, "node_modules", pkg, "native", "bin");
  if (!existsSync(dir)) {
    throw new Error(
      `pg: embedded PG binaries not found at ${dir}; run \`bun install\``,
    );
  }
  return dir;
}

// ─── symlink management ─────────────────────────────────────

/**
 * Hydrate the unversioned library aliases PG's loader needs (`libicuuc.dylib`,
 * `libicuuc.so.60`, …) from the manifest shipped inside the platform package.
 *
 * This is the ONLY thing that creates them. The platform package declares a
 * `postinstall` (`hydrate-symlinks.js`) that would, but bun does not run
 * lifecycle scripts for untrusted dependencies and nothing in this repo lists
 * these packages in `trustedDependencies` — so the manifest is load-bearing on
 * every install and, more sharply, on every shipped release: a cross-built
 * bundle's native tree has never been hydrated by anything on the build host, so
 * the aliases come into existence on the target box or not at all.
 *
 * Hence no early return on a missing manifest. Absent, PG fails much later with
 * a missing-shared-library error naming a file nobody ever asked for; here we can
 * still name the real cause.
 */
function ensureSymlinks(binDir: string): void {
  const pkgRoot = dirname(dirname(binDir)); // native/bin -> package root
  const manifestPath = join(pkgRoot, "native", "pg-symlinks.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      [
        `pg: symlink manifest not found at ${manifestPath}`,
        "",
        "Every @embedded-postgres/<platform> package ships this file in its `native/`",
        "dir, and it is what creates the unversioned library aliases PG's loader",
        "resolves against — without it the cluster cannot start.",
        "",
        "A release bundle gets it from `cpSync` of the whole `native/` tree; if it is",
        "missing here, that vendoring step dropped it. In dev, re-run `bun install`.",
      ].join("\n"),
    );
  }

  const entries: Array<{ source: string; target: string }> = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  );
  for (const { source, target } of entries) {
    const linkPath = join(pkgRoot, target);
    try {
      lstatSync(linkPath);
      continue; // already exists
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {}
    try {
      symlinkSync(basename(source), linkPath);
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

// ─── socket probe ───────────────────────────────────────────

function pingSocket(timeoutMs: number): Promise<boolean> {
  const socketPath = join(PG_SOCKET_DIR, `.s.PGSQL.${PG_PORT}`);
  return new Promise((resolve) => {
    const sock = connect(socketPath);
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

// ─── data dir checks ────────────────────────────────────────

function dataDirValid(): boolean {
  return existsSync(join(PG_DATA_DIR, "PG_VERSION"));
}

function dataDirPartial(): boolean {
  return existsSync(PG_DATA_DIR) && !dataDirValid();
}

// ─── postmaster start ───────────────────────────────────────

/**
 * Bring the postmaster up: initdb on a fresh (or half-written) data dir, then
 * `pg_ctl start`. Only reached when nothing is serving yet.
 */
function startPostmaster(binDir: string): void {
  // Partial data dir (interrupted initdb) — nuke and redo.
  if (dataDirPartial()) {
    console.log("pg: data dir partial (no PG_VERSION); cleaning and re-initdb");
    rmSync(PG_DATA_DIR, { recursive: true, force: true });
  }

  const fresh = !dataDirValid();
  if (fresh) {
    mkdirSync(PG_DIR, { recursive: true });
    mkdirSync(PG_SOCKET_DIR, { recursive: true, mode: 0o700 });
    console.log(`pg: running initdb (dataDir=${PG_DATA_DIR})`);
    const result = spawnSync(
      join(binDir, "initdb"),
      [
        "-D",
        PG_DATA_DIR,
        "-U",
        PG_USER,
        "-A",
        "trust",
        "--no-locale",
        "--encoding",
        "UTF8",
      ],
      { stdio: "pipe" },
    );
    if (result.status !== 0) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; SpawnSyncReturns fields may be null
      const out = result.stderr?.toString() || result.stdout?.toString() || "";
      throw new Error(`initdb failed: ${out}`);
    }
  } else if (existsSync(PG_PID_FILE)) {
    // Stale pidfile from a crashed prior run; pg_ctl refuses to start with it.
    console.log("pg: removing stale postmaster.pid");
    rmSync(PG_PID_FILE, { force: true });
  }

  // pg_ctl start -w: forks PG, waits for readiness, then exits. All traffic
  // stays on the Unix socket (-k/-p); `listen_addresses=''` binds NO TCP port,
  // so a self-contained release's PG never collides with the dev cluster's
  // 5433, another release's, or another preview's. The GUC is
  // postmaster-start-only, so it takes effect only on a full cluster (re)start.
  // PGHOST/PGPORT/PGUSER in env so pg_ctl's -w probe finds the socket.
  console.log(`pg: starting (socket=${PG_SOCKET_DIR}, port=${PG_PORT})`);
  const result = spawnSync(
    join(binDir, "pg_ctl"),
    [
      "start",
      "-D",
      PG_DATA_DIR,
      "-l",
      PG_LOG_FILE,
      "-o",
      `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c max_connections=${MAX_CONNECTIONS} -c listen_addresses=''`,
      "-w",
      "-t",
      String(READY_TIMEOUT_SEC),
    ],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        PGHOST: PG_SOCKET_DIR,
        PGPORT: String(PG_PORT),
        PGUSER: PG_USER,
      },
    },
  );
  if (result.status !== 0) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; SpawnSyncReturns fields may be null
    const out = result.stderr?.toString() || result.stdout?.toString() || "";
    throw new Error(`pg_ctl start failed: ${out} (see ${PG_LOG_FILE})`);
  }
}

/**
 * Create the base database if the cluster does not have it.
 *
 * Starting the cluster and minting its base database are one act. Every other
 * database in the app is a copy of this one — a worktree's fork, a served
 * composition's — so a cluster without it is a cluster nothing can be built on,
 * and until now nothing anywhere created it: a fresh clone's first build waited
 * 60s for a fork of a database that did not exist.
 *
 * Empty is correct. The schema is not this script's business; the first backend
 * to boot against the database runs the migrations, exactly as it already does
 * for every composition database and for a packaged release's own.
 *
 * Runs on EVERY start, reattach included, so a dropped base database heals on
 * the next gateway start instead of becoming the same wall a week later.
 *
 * The bundled binaries are `initdb`, `pg_ctl` and `postgres` only — no `psql`,
 * no `createdb` — so this goes over the cluster's own socket with `pg`, which
 * `bun build --compile` bundles into the release `pg-start` binary the same way
 * it already does for the compiled backend and launcher.
 */
async function ensureBaseDatabase(): Promise<void> {
  const client = new Client({
    host: PG_SOCKET_DIR,
    port: PG_PORT,
    user: PG_USER,
    database: "postgres",
  });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [PG_BASE_DATABASE],
    );
    if ((existing.rowCount ?? 0) > 0) return;

    console.log(`pg: creating base database "${PG_BASE_DATABASE}"`);
    try {
      await client.query(`CREATE DATABASE "${PG_BASE_DATABASE}"`);
    } catch (err: any) {
      // 42P04 duplicate_database: another starter won the race between the
      // SELECT above and this CREATE. That is the one tolerated error — the
      // database exists, which is all this function promised. Anything else
      // propagates and takes the script's exit code with it.
      if (err.code !== "42P04") throw err;
    }
  } finally {
    // Block form, not `eslint-disable-next-line`: a disable/enable PAIR is a
    // line RANGE and survives the format pass reflowing the line under it.
    /* eslint-disable promise-safety/no-bare-catch -- best-effort teardown of a client whose work is already done: a close error here could only mask the real failure we are propagating out of the try */
    try {
      await client.end();
    } catch {}
    /* eslint-enable promise-safety/no-bare-catch */
  }
}

// ─── main lifecycle ─────────────────────────────────────────

async function main(): Promise<void> {
  // First, before any binary resolution, any mkdir, and any spawn: nothing
  // below this line is legal as root.
  assertNotRoot();

  const binDir = resolveBinDir();
  ensureSymlinks(binDir);

  // Reattach: PG is already running, so there is no cluster to start — but we
  // still fall through to the base-database check below.
  const reattached = existsSync(PG_PID_FILE) && (await pingSocket(1500));
  if (reattached) console.log("pg: embedded PG already running; reattaching");
  else startPostmaster(binDir);

  await ensureBaseDatabase();

  console.log("pg: embedded PG ready");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
