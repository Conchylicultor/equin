/**
 * A release's backend swap: the next release's backend taken over by the
 * long-lived gateway of the host, with no restart of the host itself.
 *
 * A release host runs two generations at once:
 *
 *   - the HOST generation — the gateway, Postgres and PgBouncer, started by the
 *     launcher of whichever release last (re)started the systemd unit. It stays
 *     up across ships.
 *   - the BACKEND generation — the compiled `server` the gateway spawns from
 *     spec.json. A ship replaces it through the gateway's hot restart: the new
 *     backend boots while the old one serves, and the gateway switches once the
 *     new one is ready (gateway/worktree.go `Restart`).
 *
 * The swap is only valid while the next release's host parts are the running
 * ones. `releaseHostGeneration` digests them; the booting launcher records the
 * digest (`writeHostGeneration`) and `swapReleaseBackend` compares the next
 * release's against it — any difference is a host restart, never a swap onto a
 * gateway or Postgres the release was not built with.
 *
 * Design: research/2026-11-14-global-zero-wait-site-deploys.md.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile, rename } from "node:fs/promises";
import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { z } from "zod";
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { releaseIdentityEnv } from "@plugins/infra/plugins/paths/server";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import type { WorktreeSpec } from "@plugins/infra/plugins/worktree/server";
import { gatewayState } from "../../data-dirs";
import { gatewayBuild } from "../../deps";
import type { Ready } from "@plugins/infra/plugins/deps/deps";
import type { BuildSource } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { unbundledExecutable } from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import { runtimeEnvNames } from "@plugins/infra/plugins/launcher/plugins/runtime-env/core";
import {
  gatewayLaunchFlags,
  releaseDatabaseConfig,
  selfContainedGatewayOptions,
} from "./boot";
import { LOOPBACK_BIND, type ListenAddress } from "./listen";

/** Which release a bundle is, from its `RELEASE.json`. */
export interface ReleaseManifest {
  composition: string;
  target: string;
  platform: string;
  builtAt: string;
  port: number;
  runId?: string;
}

/**
 * The environment one release backend reads its own bundle through: every
 * bundle-relative path, and which release it is. Per release, so it travels in
 * that backend's spec (`WorktreeSpec.env`), never through the gateway's
 * inherited environment — the gateway outlives the swap. Each name is declared
 * per-release in `launcher/env-names` (withheld from inheritance).
 */
export function releaseBackendEnv(
  bundleRoot: string,
  manifest: ReleaseManifest,
  name: Namespace,
): Record<string, string> {
  return {
    // pg_dump / pg_restore for DB forks and backups: a compiled backend's
    // `import.meta.dir` is its virtual FS (database/client-tools).
    [envName("PG_CLIENT_BIN_DIR")]: join(bundleRoot, "pg-client", "bin"),
    // The migration runner reads its `.sql` files from disk; this release's,
    // so a swapped-in backend migrates to ITS schema.
    [envName("MIGRATIONS_DIR")]: join(bundleRoot, "migrations", "data"),
    // @parcel/watcher's native addon, which `bun --compile` cannot embed.
    [envName("PARCEL_WATCHER_NODE")]: join(
      bundleRoot,
      "parcel-watcher",
      "watcher.node",
    ),
    // Worker entries `bun --compile` does not trace, vendored as .js.
    [envName("SENTINEL_WORKER_JS")]: join(bundleRoot, "sentinel", "worker.js"),
    [envName("FORK_MEMORY_WORKER_JS")]: join(
      bundleRoot,
      "machine-usage",
      "fork-memory-worker.js",
    ),
    // The raw git-layer config tree (Settings "View raw", per-app un-fork).
    [envName("REPO_CONFIG_DIR")]: join(bundleRoot, "config"),
    // The served frontend's build pins (stale-tab graph, build commit, run).
    [envName("WEB_DIST")]: join(bundleRoot, "web"),
    // Which build is serving, for /api/health — what ship's gate proves.
    ...releaseIdentityEnv({ runId: manifest.runId ?? null, composition: name }),
  };
}

/** The spec the gateway spawns this bundle's backend from. */
export function releaseBackendSpec(
  bundleRoot: string,
  manifest: ReleaseManifest,
  name: Namespace,
): WorktreeSpec {
  return {
    name,
    // The binary is self-contained (closure bundled by `bun --compile`), so cwd
    // is not load-bearing — the bundle root is a stable existing dir.
    server: bundleRoot,
    web: join(bundleRoot, "web"),
    // The gateway spawns the compiled backend via this argv instead of its
    // `bun bin/index.ts` convention.
    command: [join(bundleRoot, "server")],
    composition: name,
    env: releaseBackendEnv(bundleRoot, manifest, name),
  };
}

// ── The host generation ────────────────────────────────────────────────────────

const HOST_GENERATION_FILE = "host-generation.json";

const BUNDLE = "<bundle>";
const PG_SOCKETS = "<pg-socket-dir>";

/**
 * What one part of the host generation is, as a digest. Named, so a mismatch
 * says WHICH part changed ("the gateway", "Postgres") rather than "something".
 */
const HostPartsSchema = z.object({
  gateway: z.string(),
  postgres: z.string(),
  pgbouncer: z.string(),
  pgStart: z.string(),
  pgbouncerStart: z.string(),
  gatewayFlags: z.string(),
  databaseConfig: z.string(),
});
export type HostParts = z.infer<typeof HostPartsSchema>;

const HostGenerationSchema = z.object({
  /** The extracted bundle the running gateway and daemons were started from. */
  bundleRoot: z.string(),
  parts: HostPartsSchema,
});
export type HostGeneration = z.infer<typeof HostGenerationSchema>;

async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function sha256OfText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Digest the host parts of the bundle at `bundleRoot`, for a host listening at
 * `listen`: the binaries the unit runs for its whole life (gateway, Postgres,
 * PgBouncer and their start binaries) and how the launcher starts them (the
 * gateway's flags and the database config it supervises from).
 *
 * Paths into the bundle are spelled relative to it, and the per-boot socket
 * dirs (mkdtemp'd by `launch`) are left out, so two releases with the same
 * host parts digest the same wherever each is extracted.
 */
export async function releaseHostGeneration(opts: {
  bundleRoot: string;
  /** The bundle's sealed gateway (`bundledGateway`). */
  gateway: Ready<BuildSource>;
  name: Namespace;
  listen: ListenAddress;
  publicHosts: string[];
}): Promise<HostGeneration> {
  const { bundleRoot } = opts;
  const relative = (text: string): string => {
    let out = text.split(bundleRoot).join(BUNDLE);
    const pgSockets = readEnv("PG_SOCKET_DIR");
    if (pgSockets !== undefined) out = out.split(pgSockets).join(PG_SOCKETS);
    return out;
  };
  const flags = gatewayLaunchFlags({
    // The flags name no cwd; the launch's own is the bundle (unused here).
    cwd: bundleRoot,
    ...selfContainedGatewayOptions({
      name: opts.name,
      listen: opts.listen,
      publicHosts: opts.publicHosts,
    }),
  });
  // `-sockets-dir` names a per-boot mkdtemp dir; which one is not a property of
  // the release.
  const socketsAt = flags.indexOf("-sockets-dir");
  if (socketsAt >= 0) flags.splice(socketsAt, 2);
  return {
    bundleRoot,
    parts: {
      gateway: await sha256OfFile(
        unbundledExecutable(gatewayBuild(opts.gateway)).path,
      ),
      postgres: await sha256OfFile(
        join(bundleRoot, "pg", "native", "bin", "postgres"),
      ),
      pgbouncer: await sha256OfFile(
        join(bundleRoot, "pgbouncer", "native", "bin", "pgbouncer"),
      ),
      pgStart: await sha256OfFile(join(bundleRoot, "pg", "pg-start")),
      pgbouncerStart: await sha256OfFile(
        join(bundleRoot, "pgbouncer", "pgbouncer-start"),
      ),
      gatewayFlags: sha256OfText(
        relative(JSON.stringify([...flags, ...runtimeEnvNames()])),
      ),
      databaseConfig: sha256OfText(
        relative(JSON.stringify(releaseDatabaseConfigFor(bundleRoot))),
      ),
    },
  };
}

/** The database config a release at `bundleRoot` supervises Postgres from. */
export function releaseDatabaseConfigFor(bundleRoot: string): unknown {
  return releaseDatabaseConfig({
    pgStartBin: join(bundleRoot, "pg", "pg-start"),
    pgbouncerStartBin: join(bundleRoot, "pgbouncer", "pgbouncer-start"),
  });
}

/** Record the running host generation, for the next release's swap to compare. */
export async function writeHostGeneration(gen: HostGeneration): Promise<void> {
  await gatewayState.ensure();
  const path = gatewayState.file(HOST_GENERATION_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(gen, null, 2) + "\n");
  await rename(tmp, path);
}

async function readHostGeneration(): Promise<HostGeneration | undefined> {
  const path = gatewayState.file(HOST_GENERATION_FILE);
  if (!(await exists(path))) return undefined;
  return HostGenerationSchema.parse(JSON.parse(await readFile(path, "utf-8")));
}

// ── The swap ──────────────────────────────────────────────────────────────────

/** How a swap ended. `host-differs` is not a failure: it asks for a host restart. */
export type SwapOutcome =
  | { kind: "swapped" }
  | { kind: "host-differs"; reason: string }
  | { kind: "failed"; reason: string };

/** Readiness can take the gateway's extended readiness window; never shorter. */
const SWAP_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Swap the host's backend for this bundle's, through the running gateway.
 *
 * Refuses (`host-differs`) unless the running host generation is this bundle's
 * own: a backend never runs under a gateway or Postgres its release was not
 * built with. Otherwise posts this bundle's spec to the gateway's restart
 * route, which boots it beside the serving backend and commits the spec only
 * once it is ready — a backend that never gets ready leaves the old one
 * serving and the spec unchanged (gateway/CLAUDE.md, the restart route).
 */
export async function swapReleaseBackend(opts: {
  next: HostGeneration;
  spec: WorktreeSpec;
  listen: ListenAddress;
}): Promise<SwapOutcome> {
  const running = await readHostGeneration();
  if (running === undefined) {
    return {
      kind: "host-differs",
      reason:
        "no host generation is recorded (the running host predates backend swaps)",
    };
  }
  const changed = (Object.keys(opts.next.parts) as (keyof HostParts)[]).filter(
    (k) => running.parts[k] !== opts.next.parts[k],
  );
  if (changed.length > 0) {
    return {
      kind: "host-differs",
      reason: `this release changes the host's ${changed.join(", ")}`,
    };
  }

  const { name, ...spec } = opts.spec;
  const url = `http://${gatewayDialAddress(opts.listen)}/gateway/worktrees/${name}/restart`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
      signal: AbortSignal.timeout(SWAP_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: "failed",
      reason: `the gateway at ${url} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.ok) return { kind: "swapped" };
  return {
    kind: "failed",
    reason: `the gateway refused the swap (HTTP ${res.status}): ${(await res.text()).trim()}`,
  };
}

/** Where to dial the host's gateway from the host itself. */
function gatewayDialAddress(listen: ListenAddress): string {
  // A wildcard or the loopback pair answers on 127.0.0.1; a literal on itself.
  const host =
    listen.host === null || listen.host === LOOPBACK_BIND
      ? "127.0.0.1"
      : listen.host;
  return `${host}:${listen.port}`;
}
