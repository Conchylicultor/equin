import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
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
 * module-level consts over `EQUIN_PG_PORT` / `EQUIN_PG_SOCKET_DIR`.
 * One frozen constant anywhere in the closure is enough to make the ordering
 * load-bearing, so keep the dynamic import until that family is lazy too.
 */
import { dirname, join } from "node:path";
import {
  readEnv,
  setEnvDefault,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { mkdtempSync } from "node:fs";
import type { ReleaseManifest } from "@plugins/infra/plugins/launcher/server";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
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
// declared runtime environment (`RUNTIME_FORWARDED_ENV` in launcher/env-names). The
// gateway spawn drops every other name. A new relocation variable therefore
// goes on that list too; the `launcher:runtime-env-declared` check makes you
// decide.
// Re-root the entire install under the bundle (data, logs, the PG cluster, the
// registry, the pid file) so a release never touches the dev `~/.equin`.
// `??=` lets an operator override the data root (e.g. point at a persistent
// volume) without editing the binary.
setEnvDefault("DIR", join(bundleRoot, "data"));
// Mark this as a compiled release so host-singleton work that keys on the dev
// "main" worktree (the cluster sentinel + duress latch) also runs on a
// release's single backend, whose runtime namespace is the composition name
// (so isMain() is false). Travels launch → gateway → backend because it is a
// forwarded name in the declared runtime environment (launcher/core). Read via
// isRelease() in infra/paths.
setEnvDefault("RELEASE", "1");
// Point the compiled pg-start / pgbouncer-start at the vendored native trees.
// Both are forwarded names, so the gateway receives them and passes them to the
// supervised start binaries.
setEnvDefault("PG_BIN_DIR", join(bundleRoot, "pg", "native", "bin"));
setEnvDefault(
  "PGBOUNCER_BIN",
  join(bundleRoot, "pgbouncer", "native", "bin", "pgbouncer"),
);
// What ONE backend reads of its own bundle — the vendored migrations, web tree,
// workers, pg client tools and config tree, and which release it is — is NOT set
// here: the gateway outlives a backend swap, so a value inherited through it
// would run the next release's backend against this release's files. It travels
// in the backend's spec (`releaseBackendSpec`, `WorktreeSpec.env`).

// Reroot the embedded-PG / PgBouncer sockets AND the gateway's per-worktree
// backend sockets onto short `/tmp` paths (each reads a single env override).
// The data root above may be a long versioned `<out>/data`
// (`releases/<wt>/<comp>-<target>/<run-id>/data`), which would blow the 104-byte
// AF_UNIX socket-path cap; the socket dirs are decoupled so length never
// constrains where a release is staged.
//
// `launch swap` starts nothing that listens on a socket: it only digests how
// this release WOULD start the host, so it names the socket dir by the
// placeholder the digest spells it as, instead of minting a dir under /tmp.
const verb = process.argv[2];
if (verb === "swap") {
  setEnvDefault("PG_SOCKET_DIR", "/<pg-socket-dir>");
} else if (verb !== undefined) {
  throw new Error(
    `launch: unknown verb "${verb}" — run with no argument to start the app, or "swap" to swap the running host's backend for this release's.`,
  );
}
if (readEnv("PG_SOCKET_DIR") === undefined) {
  setEnvDefault("PG_SOCKET_DIR", mkdtempSync(join("/tmp", "sgs-")));
}
if (readEnv("SOCKETS_DIR") === undefined && verb === undefined) {
  setEnvDefault("SOCKETS_DIR", mkdtempSync(join("/tmp", "sgw-")));
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
    releaseBackendSpec,
    releaseHostGeneration,
    writeHostGeneration,
    swapReleaseBackend,
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

  // Where to listen: `EQUIN_LISTEN=host:port` if set, else the port baked
  // into RELEASE.json on loopback (127.0.0.1 and [::1]); `:port` is the explicit
  // wildcard opt-in. That env var is the ONE runtime
  // authority — it replaced the older `PORT` override rather than joining it,
  // because `PORT` is the same knob minus the bind host, and the bind host is
  // what keeps a deployment's gateway off the public internet. See
  // `launcher/server/internal/listen.ts`.
  const listen = resolveListenAddress(manifest.port);
  const { host: bindHost, port } = listen;
  const publicHosts = (readEnv("PUBLIC_HOSTS") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  const gatewayReady = await bundledGateway(asAppPath(bundleRoot));
  // How this release starts the host (gateway, Postgres, PgBouncer): recorded
  // by a boot once it serves (digesting ~250 MB of binaries is no part of the
  // restart gap), compared by a swap.
  const hostGeneration = () =>
    releaseHostGeneration({
      bundleRoot,
      gateway: gatewayReady,
      name,
      listen,
      publicHosts,
    });
  const backendSpec = releaseBackendSpec(bundleRoot, manifest, name);

  if (verb === "swap") {
    // The per-release boot steps a running host still needs from this bundle,
    // before its backend boots: the build-owned config layer and the
    // pre-warmed asset mirror (copy-if-absent).
    seedReleaseAssetMirror({
      bundleRoot: asAppPath(bundleRoot),
      dataDir: asAppPath(readEnv("DIR")!),
      log: console.log,
    });
    await propagateReleaseConfig({
      bundleRoot: asAppPath(bundleRoot),
      dataDir: asAppPath(readEnv("DIR")!),
      worktreeName: name,
      log: console.log,
    });
    const outcome = await swapReleaseBackend({
      next: await hostGeneration(),
      spec: backendSpec,
      listen,
    });
    switch (outcome.kind) {
      case "swapped":
        console.log(`Swapped "${name}"'s backend to ${bundleRoot}.`);
        process.exit(0);
      case "host-differs":
        // Exit 3: not a failure — the caller restarts the host instead.
        console.error(`host differs: ${outcome.reason}`);
        process.exit(3);
      case "failed":
        console.error(`swap failed: ${outcome.reason}`);
        process.exit(1);
    }
  }

  // Write the release database.json FIRST, so bootSelfContainedApp's internal
  // ensureDatabaseConfig sees the file already present and no-ops (a release has
  // no node_modules to probe). The service `start` argv point at the vendored
  // compiled start binaries.
  await writeReleaseDatabaseConfig(
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
    bundleRoot: asAppPath(bundleRoot),
    dataDir: asAppPath(readEnv("DIR")!),
    log: console.log,
  });

  // Propagate this bundle's resolved config origins into the writable data dir,
  // on EVERY boot — the data dir outlives a deploy, so a once-only seed would
  // serve the FIRST bundle's config forever. Only the build-owned origin layer
  // is written; the user's own `.jsonc` overrides are left alone. worktreeName
  // = composition = the backend's runtime namespace, so this lands exactly where
  // config-dir.ts reads (EQUIN_DIR/config/<worktree>). Runs before the
  // gateway spawns the backend, so CONFIG_DIR is current on first read.
  await propagateReleaseConfig({
    bundleRoot: asAppPath(bundleRoot),
    dataDir: asAppPath(readEnv("DIR")!),
    worktreeName: name,
    log: console.log,
  });

  const { gateway } = await bootSelfContainedApp({
    name,
    // Sealed into the bundle by `release` (deps.sealed.json): read, never
    // built — this host has no Go toolchain and no source.
    gateway: gatewayReady,
    // For a release the app's namespace IS its composition id (`name`), which is
    // also what `releaseIdentity` and `propagateReleaseConfig` above are keyed by.
    composition: name,
    // The backend this bundle runs, and what it reads of its own bundle
    // (`releaseBackendSpec`): the same spec a later release's swap posts.
    server: backendSpec.server,
    command: backendSpec.command,
    web: backendSpec.web!,
    backendEnv: backendSpec.env,
    port,
    bindHost,
    // A deployed site's own public hostnames (the converge env file); unset
    // everywhere else.
    publicHosts,
    repoRoot: asAppPath(bundleRoot),
    log: console.log,
  });

  // The host generation now running — what the next release's swap compares
  // its own against. Written once the stack serves, so a host that never came
  // up names no generation a swap could join.
  await writeHostGeneration(await hostGeneration());

  console.log("");
  console.log(`App "${name}" is serving.`);
  console.log(`  URL:  ${namespaceUrl(name, "", port)}`);
  console.log(`  Root: ${readEnv("DIR")}`);

  // ── Stay in the foreground. ────────────────────────────────────────────────
  //
  // This process IS the app, to everything that launches it: systemd treats the
  // exit of `ExecStart` as the service dying and reaps the whole cgroup — the
  // gateway and Postgres included — and a desktop launch should stop the app
  // when you close it, the way every other application behaves. Returning here
  // used to leave a detached stack behind, which read as "started successfully"
  // locally (nothing was watching) and as a restart loop under systemd.
  //
  // `./equin start` is the deliberate exception: it is the one command
  // whose job is to leave a daemon running, and it does not `.ref()`.
  //
  // The gateway handle serves both jobs at once — it keeps the event loop alive
  // (so there is no keepalive timer to invent) and it resolves exactly when the
  // gateway dies, which is the event that means the app is gone.
  gateway.ref();

  const root = readEnv("DIR")!;
  let stopping = false;
  async function stop(reason: string, code: number): Promise<void> {
    if (stopping) return; // A second SIGTERM must not race the first teardown.
    stopping = true;
    console.log(`\n${reason} — shutting down...`);
    await teardownSelfContainedApp(
      // The cluster is the site's data: a fast shutdown with a checkpoint,
      // waited out — under KillMode=mixed whatever outlives this process is
      // SIGKILLed.
      { root: asAppPath(root), httpPort: port, postgres: "fast" },
      console.log,
    );
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
