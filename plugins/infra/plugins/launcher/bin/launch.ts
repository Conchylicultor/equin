/**
 * Release launcher — the compiled `launch` binary, the artifact's entrypoint.
 *
 * Compiled by `release.ts` via `bun build --compile` and placed at the bundle
 * root, next to `deps/` + `deps.sealed.json` (the sealed gateway), `server`,
 * `web/`, `pg/`, `pgbouncer/`, and `RELEASE.json`. Running it brings up the
 * whole self-contained app on a fresh host with no bun, no Go toolchain, and no
 * node_modules.
 *
 * CRITICAL ordering: some path constants are FROZEN at import time from the env
 * vars set below, so this file must set them BEFORE importing anything
 * path-dependent. We therefore do NOT statically import the launcher boot code —
 * we `await import(...)` it only after the env is in place, so those constants
 * freeze under the release root.
 *
 * `@plugins/infra/plugins/paths` no longer contributes to this: `dataRoot()`,
 * `worktreesDir()`, `repoConfigDir()` and `webDistDir()` are all functions, and
 * `DataDir.path` is a getter, so nothing there captures an env read. What still
 * freezes is the embedded-PG family — `PG_PORT`, `PG_SOCKET_DIR` and the paths
 * derived from them (`database/embedded/shared/internal/paths.ts`) are
 * module-level consts over `SINGULARITY_PG_PORT` / `SINGULARITY_PG_SOCKET_DIR`.
 * One frozen constant anywhere in the closure is enough to make the ordering
 * load-bearing, so keep the dynamic import until that family is lazy too.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
// Zero-import and path-independent, so the ordering constraint above does not
// apply to it — nothing here freezes a path constant.
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";

// `process.execPath` is the compiled `launch` binary; its dir is the bundle
// root (the extracted bundle dir when packed, or the staged dir for `--dev`).
const bundleRoot = dirname(process.execPath);

// Every variable set below reaches the gateway, and through it the backend and
// the supervised start binaries, only because it is a FORWARDED name in the
// declared runtime environment (`RUNTIME_FORWARDED_ENV` in launcher/core). The
// gateway spawn drops every other name. A new relocation variable therefore
// goes on that list too; the `launcher:runtime-env-declared` check makes you
// decide.
// Re-root the entire install under the bundle (data, logs, the PG cluster, the
// registry, the pid file) so a release never touches the dev `~/.singularity`.
// `??=` lets an operator override the data root (e.g. point at a persistent
// volume) without editing the binary.
process.env.SINGULARITY_DIR ??= join(bundleRoot, "data");
// Mark this as a compiled release so host-singleton work that keys on the dev
// "main" worktree (the cluster sentinel + duress latch) also runs on a
// release's single backend, whose runtime namespace is the composition name
// (so isMain() is false). Travels launch → gateway → backend because it is a
// forwarded name in the declared runtime environment (launcher/core). Read via
// isRelease() in infra/paths.
process.env.SINGULARITY_RELEASE ??= "1";
// Point the compiled pg-start / pgbouncer-start at the vendored native trees.
// Both are forwarded names, so the gateway receives them and passes them to the
// supervised start binaries.
process.env.SINGULARITY_PG_BIN_DIR ??= join(bundleRoot, "pg", "native", "bin");
process.env.SINGULARITY_PGBOUNCER_BIN ??= join(
  bundleRoot,
  "pgbouncer",
  "native",
  "bin",
  "pgbouncer",
);
// The backend spawns pg_dump / pg_restore for DB forks and backups; a compiled
// backend's `import.meta.dir` is its virtual FS, so point it at the vendored
// tools. A forwarded name, so the gateway hands it to the spawned backend.
process.env.SINGULARITY_PG_CLIENT_BIN_DIR ??= join(
  bundleRoot,
  "pg-client",
  "bin",
);
// The migration runner reads its `.sql` files from disk; `import.meta.dir`
// resolves into the compiled binary's virtual FS, so point it at the vendored
// `migrations/data` tree. A forwarded name, so the gateway receives it and
// hands it to the spawned backend, which is the process that actually runs
// migrations.
process.env.SINGULARITY_MIGRATIONS_DIR ??= join(
  bundleRoot,
  "migrations",
  "data",
);
// @parcel/watcher's native .node can't be embedded by `bun --compile`; point the
// file-watcher loader at the vendored addon. A forwarded name, so the gateway
// hands it to the spawned backend, which is the process that starts watchers.
process.env.SINGULARITY_PARCEL_WATCHER_NODE ??= join(
  bundleRoot,
  "parcel-watcher",
  "watcher.node",
);
// The cluster sentinel's Bun Worker entry can't be embedded by `bun --compile`
// (the `new Worker(new URL(...))` module is not traced), so release.ts vendors
// it as a standalone bundled .js; point worker-host.ts at it. A forwarded
// name, so the gateway hands it to the spawned backend, which spawns the worker.
process.env.SINGULARITY_SENTINEL_WORKER_JS ??= join(
  bundleRoot,
  "sentinel",
  "worker.js",
);
// The raw git-layer config tree is read by the config-v2.raw-file loader
// (Settings "View raw") and gitBacksScope (per-app un-fork). REPO_ROOT resolves
// into the compiled binary's virtual FS, so point these at the vendored tree.
process.env.SINGULARITY_REPO_CONFIG_DIR ??= join(bundleRoot, "config");
// The served frontend. In dev this derives from the namespace
// (`~/.singularity/worktrees/<name>/web`); a release ships one bundle whose web
// tree is vendored at `<bundleRoot>/web` (already carrying `.build-graph` /
// `.build-commit` / `.build-id`, copied by release.ts), so point the backend's
// readers — the stale-tab graph pin, the build-commit base, the producing run —
// at it. Travels launch → gateway → backend, like every var above.
process.env.SINGULARITY_WEB_DIST ??= join(bundleRoot, "web");
// Reroot the embedded-PG / PgBouncer sockets AND the gateway's per-worktree
// backend sockets onto short `/tmp` paths (each reads a single env override).
// The data root above may be a long versioned `<out>/data`
// (`releases/<wt>/<comp>-<target>/<run-id>/data`), which would blow the 104-byte
// AF_UNIX socket-path cap; the socket dirs are decoupled so length never
// constrains where a release is staged.
process.env.SINGULARITY_PG_SOCKET_DIR ??= mkdtempSync(join("/tmp", "sgs-"));
process.env.SINGULARITY_SOCKETS_DIR ??= mkdtempSync(join("/tmp", "sgw-"));

interface ReleaseManifest {
  composition: string;
  target: string;
  platform: string;
  builtAt: string;
  port: number;
  runId?: string;
}

function readReleaseManifest(): ReleaseManifest {
  const path = join(bundleRoot, "RELEASE.json");
  if (!existsSync(path)) {
    throw new Error(
      `RELEASE.json not found at ${path}. The launch binary must sit at the bundle root next to RELEASE.json.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as ReleaseManifest;
}

async function main(): Promise<void> {
  // Imported AFTER env is set (see the ordering constraint at the top of this
  // file), so the launcher's path constants freeze under the release root.
  const {
    assertSupportedHost,
    bootSelfContainedApp,
    bundledGateway,
    teardownSelfContainedApp,
    writeReleaseDatabaseConfig,
    seedReleaseAssetMirror,
    propagateReleaseConfig,
    resolveListenAddress,
  } = await import("@plugins/infra/plugins/launcher/server");

  // Host preconditions first, before anything is read, written or spawned: a
  // root launch cannot start Postgres, and every later symptom of that is a
  // misdirecting downstream timeout. This is the earliest seam available — the
  // check lives behind the barrel the ordering constraint forbids importing
  // until the env is frozen, so the two module-level `mkdtempSync` calls above
  // still run and leave two empty /tmp dirs on a refused launch. Accepted:
  // restructuring the env preamble to avoid them would trade a correctness
  // constraint for cosmetics.
  assertSupportedHost();

  const manifest = readReleaseManifest();
  // RELEASE.json is a serialization boundary: validate before it becomes a
  // subdomain, a spec dir and a database name.
  const name = asNamespace(manifest.composition);

  // Where to listen: `SINGULARITY_LISTEN=host:port` if set, else the port baked
  // into RELEASE.json on a wildcard bind. That env var is the ONE runtime
  // authority — it replaced the older `PORT` override rather than joining it,
  // because `PORT` is the same knob minus the bind host, and the bind host is
  // what keeps a deployment's gateway off the public internet. See
  // `launcher/server/internal/listen.ts`.
  const { host: bindHost, port } = resolveListenAddress(manifest.port);

  // Write the release database.json FIRST, so bootSelfContainedApp's internal
  // ensureDatabaseConfig sees the file already present and no-ops (a release has
  // no node_modules to probe). The service `start` argv point at the vendored
  // compiled start binaries.
  writeReleaseDatabaseConfig(
    {
      pgStartBin: join(bundleRoot, "pg", "pg-start"),
      pgbouncerStartBin: join(bundleRoot, "pgbouncer", "pgbouncer-start"),
    },
    console.log,
  );

  // Seed the asset-mirror cache from the bundle on first run (copy-if-absent),
  // so offline cold starts have their pre-warmed assets before the backend
  // serves any mirror request. Routed through the launcher/server barrel this
  // bin already dynamic-imports (after the env freeze): a bin entrypoint may not
  // statically import path-dependent code, and the boundary rules (R9) forbid a
  // literal cross-plugin dynamic import — so the launcher owns the boot step and
  // delegates the copy mechanics + dirname to asset-mirror.
  seedReleaseAssetMirror({
    bundleRoot,
    dataDir: process.env.SINGULARITY_DIR!,
    log: console.log,
  });

  // Propagate this bundle's resolved config origins into the writable data dir,
  // on EVERY boot — the data dir outlives a deploy, so a once-only seed would
  // serve the FIRST bundle's config forever. Only the build-owned origin layer
  // is written; the user's own `.jsonc` overrides are left alone. worktreeName
  // = composition = the backend's runtime namespace, so this lands exactly where
  // config-dir.ts reads (SINGULARITY_DIR/config/<worktree>). Runs before the
  // gateway spawns the backend, so CONFIG_DIR is current on first read.
  propagateReleaseConfig({
    bundleRoot,
    dataDir: process.env.SINGULARITY_DIR!,
    worktreeName: name,
    log: console.log,
  });

  const { gateway } = await bootSelfContainedApp({
    name,
    // Sealed into the bundle by `release` (deps.sealed.json): read, never
    // built — this host has no Go toolchain and no source.
    gateway: await bundledGateway(bundleRoot),
    // Which build is serving, for /api/health to report — see setReleaseIdentity.
    // `runId` is absent on a bundle built outside a tracked release run.
    releaseIdentity: { runId: manifest.runId ?? null, composition: name },
    // For a release the app's namespace IS its composition id (`name`), which is
    // also what `releaseIdentity` and `propagateReleaseConfig` above are keyed by.
    composition: name,
    // The compiled backend's cwd. The binary is self-contained (closure bundled
    // by `bun --compile`), so cwd is not load-bearing — bundleRoot is a stable
    // existing dir.
    server: bundleRoot,
    // The gateway spawns the compiled backend via this argv (Spec.command),
    // instead of its `bun bin/index.ts` convention.
    command: [join(bundleRoot, "server")],
    web: join(bundleRoot, "web"),
    port,
    bindHost: bindHost ?? undefined,
    repoRoot: bundleRoot,
    log: console.log,
  });

  console.log("");
  console.log(`App "${name}" is serving.`);
  console.log(`  URL:  ${namespaceUrl(name, "", port)}`);
  console.log(`  Root: ${process.env.SINGULARITY_DIR}`);

  // ── Stay in the foreground. ────────────────────────────────────────────────
  //
  // This process IS the app, to everything that launches it: systemd treats the
  // exit of `ExecStart` as the service dying and reaps the whole cgroup — the
  // gateway and Postgres included — and a desktop launch should stop the app
  // when you close it, the way every other application behaves. Returning here
  // used to leave a detached stack behind, which read as "started successfully"
  // locally (nothing was watching) and as a restart loop under systemd.
  //
  // `./singularity start` is the deliberate exception: it is the one command
  // whose job is to leave a daemon running, and it does not `.ref()`.
  //
  // The gateway handle serves both jobs at once — it keeps the event loop alive
  // (so there is no keepalive timer to invent) and it resolves exactly when the
  // gateway dies, which is the event that means the app is gone.
  gateway.ref();

  const root = process.env.SINGULARITY_DIR!;
  let stopping = false;
  async function stop(reason: string, code: number): Promise<void> {
    if (stopping) return; // A second SIGTERM must not race the first teardown.
    stopping = true;
    console.log(`\n${reason} — shutting down...`);
    await teardownSelfContainedApp({ root, httpPort: port }, console.log);
    process.exit(code);
  }

  process.on("SIGTERM", () => void stop("Received SIGTERM", 0));
  process.on("SIGINT", () => void stop("Received SIGINT", 0));

  const gatewayExit = await gateway.exited;
  // Reached only when the gateway died on its OWN — we were never asked to
  // stop. That is a failure even when it exited 0, so never report success:
  // under a supervisor, exit 0 means "the service finished", which would leave
  // a dead app un-restarted.
  await stop(
    `Gateway exited (code ${gatewayExit})`,
    gatewayExit === 0 ? 1 : gatewayExit,
  );
}

await main();
