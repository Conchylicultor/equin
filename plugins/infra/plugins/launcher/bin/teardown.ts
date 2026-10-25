/**
 * Release teardown — the compiled `teardown` binary, the bundle's stop entrypoint.
 *
 * Mirror of `launch.ts`'s env-rooting preamble, then stops the self-contained
 * stack (gateway → PgBouncer → Postgres) via the pidfiles under the data root.
 * It only signals pidfiles — it does NOT delete the data dir — so a packaged
 * install's songs/DB persist across app restarts.
 *
 * Invoked by the desktop (Tauri) shell on app exit with the SAME `EQUIN_DIR`
 * / `EQUIN_LISTEN` env the launcher saw, so it tears down exactly the stack
 * `launch` brought up. The gateway / Postgres are detached daemons (not the shell's
 * children), so pidfile-based teardown is the authoritative stop.
 *
 * CRITICAL ordering (same as launch.ts): set the path env BEFORE importing
 * anything path-dependent, then `await import(...)` so the constants freeze under
 * the release root.
 */
import {
  readEnv,
  setEnvDefault,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// `process.execPath` is the compiled `teardown` binary; its dir is the bundle
// root (extracted bundle dir when packed, or the staged dir for `--dev`).
const bundleRoot = dirname(process.execPath);

// Re-root under the bundle, matching launch.ts. `??=` lets the desktop shell (or
// an operator) point at the actual install root via inherited env.
const dataRoot = setEnvDefault("DIR", join(bundleRoot, "data"));

interface ReleaseManifest {
  composition: string;
  target: string;
  platform: string;
  builtAt: string;
  port: number;
}

function readReleaseManifest(): ReleaseManifest {
  const path = join(bundleRoot, "RELEASE.json");
  if (!existsSync(path)) {
    throw new Error(
      `RELEASE.json not found at ${path}. The teardown binary must sit at the bundle root next to RELEASE.json.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as ReleaseManifest;
}

async function main(): Promise<void> {
  const manifest = readReleaseManifest();

  // Imported AFTER env is set, so the launcher's path constants freeze under the
  // release root. (Same-plugin dynamic import — the env-before-import ordering
  // launch.ts relies on; teardown itself only needs `root`, which it passes
  // explicitly.)
  const { teardownSelfContainedApp, resolveListenAddress } = await import(
    "@plugins/infra/plugins/launcher/server"
  );

  // The HTTP listen port, resolved by the SAME function launch.ts uses (one
  // authority: EQUIN_LISTEN, else the baked manifest value) — so teardown
  // cannot target a different gateway than the one launch brought up.
  const { port: httpPort } = resolveListenAddress(manifest.port);

  // PG is killed via its postmaster pidfile under `root` — the authoritative
  // stop. The pgPort arg is only a loopback-TCP backstop, relevant when the
  // cluster runs on a non-default port; a desktop install uses the default, so we
  // pass it through only when EQUIN_PG_PORT is explicitly set. (Reading the
  // env here avoids a cross-plugin import of the embedded PG_PORT constant.)
  const pgPortRaw = readEnv("PG_PORT");
  const pgPort = pgPortRaw ? Number(pgPortRaw) : undefined;

  await teardownSelfContainedApp(
    {
      root: dataRoot,
      // Already validated by resolveListenAddress, which throws on a bad value
      // rather than handing back one to re-check here.
      httpPort,
      pgPort:
        pgPort !== undefined && Number.isInteger(pgPort) && pgPort > 0
          ? pgPort
          : undefined,
    },
    console.log,
  );
}

await main();
