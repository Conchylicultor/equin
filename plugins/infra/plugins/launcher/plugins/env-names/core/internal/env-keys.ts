// The app's own environment variables, declared by KEY.
//
// Every variable the app reads or sets is one of two kinds — an installation
// setting the runtime tree must inherit (forwarded), or somebody's own state it
// must never inherit (withheld); `runtime-env.ts` says why the split exists and
// how the gateway enforces it.
//
// A key's one name is `EQUIN_<key>` (`envName`). Code spells only the key
// (`env.ts`): an undeclared one is a type error, and `launcher:env-names`
// rejects a full name in TypeScript code.
//
// Design: research/2026-10-25-global-equin-env-vars.md,
// research/2026-10-28-global-equin-env-vars-drop-legacy.md

import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/**
 * Installation settings that must reach the runtime, each with the reason it
 * travels and who reads it there. Most are set by the release launcher
 * (`launcher/bin/launch.ts`) to point the runtime at the bundle's vendored
 * files; the rest are operator knobs an installation may set once.
 */
export const RUNTIME_FORWARDED_ENV = {
  DIR: "the data root every path derives from; a release and a preview re-root their whole install with it (paths/core dataRoot(), gateway/main.go flag defaults)",
  SOCKETS_DIR:
    "short /tmp dir for backend sockets when the data root is too deep for the AF_UNIX cap; the launcher passes it as -sockets-dir and gateway/main.go reads it as that flag's default",
  RELEASE:
    "marks a compiled release, so its single backend takes the host-singleton work (paths/core isRelease())",
  RELEASE_RUN_ID:
    "which release run is serving, stamped by the launcher from RELEASE.json for /api/health (paths/core releaseIdentity())",
  RELEASE_COMPOSITION:
    "which composition is serving, stamped by the launcher from RELEASE.json for /api/health (paths/core releaseIdentity())",
  PG_BIN_DIR:
    "vendored Postgres binaries for the supervised start script (database/embedded/scripts/start.ts)",
  PGBOUNCER_BIN:
    "vendored PgBouncer binary for the supervised start script (database/pgbouncer/scripts/start.ts)",
  PG_CLIENT_BIN_DIR:
    "vendored pg_dump / pg_restore the backend spawns for DB forks and backups (database/client-tools server/internal/bin.ts)",
  PG_PORT:
    "the embedded cluster's port, which a preview moves off the default (database/embedded/shared/internal/paths.ts, database/pgbouncer/scripts/start.ts)",
  PG_SOCKET_DIR:
    "short /tmp dir for the Postgres / PgBouncer sockets under a deep release root (database/embedded/shared/internal/paths.ts, database/pgbouncer/shared/internal/paths.ts)",
  MIGRATIONS_DIR:
    "the vendored .sql tree, since a compiled backend cannot read its own (database/migrations/server/internal/runner.ts)",
  PARCEL_WATCHER_NODE:
    "the vendored @parcel/watcher addon, which `bun --compile` cannot embed (infra/file-watcher shared/engine.ts)",
  SENTINEL_WORKER_JS:
    "the vendored cluster-sentinel worker, which `bun --compile` does not trace (debug/sentinel worker-host.ts)",
  REPO_CONFIG_DIR:
    "the vendored git-layer config tree for a compiled backend (paths/core repoConfigDir())",
  WEB_DIST:
    "the release's vendored web bundle, which the backend reads its build pins from (paths/core webDistDir())",
  CLAUDE_BIN:
    "where the backend finds the claude CLI (infra/paths/server bins.ts)",
  PROFILING:
    "operator kill-switch for the runtime profiler (infra/runtime-profiler/core recorder.ts)",
  NO_SPAWN_PRIORITY:
    "operator escape hatch that turns off darwinbg demotion of background work (packages/spawn-priority background.ts)",
  NO_SIGNAL_ORIGIN:
    "operator escape hatch that turns off the native signal-origin tap (packages/signal-origin signal-origin.ts)",
  NO_SPAWN_DISCLAIM:
    "operator escape hatch that runs agents' claude without the disclaim-exec helper; read by the backend that resolves it (packages/spawn-disclaim disclaim-argv.ts)",
  HEAVY_READ_LOCAL_CONCURRENCY:
    "operator tuning for the per-backend heavy-read gate (infra/host/host-read-pool pool.ts)",
  CODESIGN_IDENTITY:
    "operator-set keychain identity the gateway is code-signed with; a backend's deps.install job can build (and so sign) the gateway too, and must use the same signer as `./equin start` (infra/codesign identity.ts)",
} as const satisfies Record<string, string>;

/**
 * Name PREFIXES that travel: every variable starting with one is forwarded.
 * Passed to the gateway as `<prefix>*`.
 */
export const RUNTIME_FORWARDED_PREFIXES = {
  AUTH_:
    "operator-set OAuth client credentials, EQUIN_AUTH_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET, read by central (auth/google, auth/notion central descriptor.ts)",
} as const satisfies Record<string, string>;

/**
 * Names that exist in the code but must NEVER be inherited by the runtime tree,
 * each with who delivers it instead. A backend that inherited one of these
 * would act as whichever process happened to start the gateway.
 */
export const RUNTIME_WITHHELD_ENV = {
  CONVERSATION_ID:
    "agent-session identity; the agent launcher delivers it into that agent's own process environment, where the commit hook and op-log read it",
  TOOL_USE_ID:
    "the Bash tool call an e2e script was launched by; a PreToolUse guard exports it into that one command, never a backend's",
  PARENT_HOST:
    "the host an agent's MCP client dials back to; delivered into that agent's own process environment by the agent launcher",
  GUARDS_ROOT:
    "the checkout one agent's policy hooks run their guards from (guards/agent-policy); delivered into that agent's own process environment by the agent launcher",
  WORKSPACE_ROOT:
    "the workspace one agent runs in, its write guards' boundary (guards/agent-policy); delivered into that agent's own process environment by the agent launcher",
  PARENT_LIFELINE:
    "the lock file one spawn holds for the child it starts, set by infra/spawn for that child only (packages/flock lifeline.ts)",
  HOST_GRANT:
    "a host CPU admission grant, set by a grant holder for the subprocess it spawns (infra/host/host-admission grant.ts)",
  LANE: "the admission lane of a CLI op, set by the op for the subprocesses it spawns (cli/op-runtime lane.ts)",
  BUILD_ID:
    "the build_runs row a UI-triggered build writes to, set by the backend for the build it spawns (build/server run-build.ts)",
  BUILD_DETACHED:
    "marks a supervised build that must outlive its backend, set by the backend for the build it spawns (build/server run-build.ts)",
  FOREGROUND_DEADLINE:
    "the instant (epoch ms) an agent's foreground Bash call is cut off; a PreToolUse guard exports it into that one command, and the op hand-off takes it out of the env of the op it detaches (cli/op-runtime foreground-handoff.ts)",
  OP_HANDED_OFF:
    "marks an op detached by the foreground hand-off, meant to outlive the call that started it; set by the hand-off for that one op (cli/op-runtime foreground-handoff.ts), read by its orphan guard",
  BUILD_IN_PROGRESS:
    "marks the check pass a build spawns, set by that build (tooling/checks/core run-context.ts)",
  CHECK_JOBS:
    "check fan-out width for one check run, typed by whoever runs it; reaches that run's subprocesses, never a backend",
  CHECK_NO_CACHE:
    "cache bypass for one check run, typed by whoever runs it; reaches that run's subprocesses, never a backend",
  CHECK_SHADOW:
    "shadow-mode switch for one check run, typed by whoever runs it; reaches that run's subprocesses, never a backend",
  DEPS_REEXEC:
    "re-exec budget the CLI carries across its own dependency-install re-exec; taken out of the env by the bootstrap, so it never reaches a descendant (cli/bootstrap reexec.ts)",
  LOCKED_BUN_REEXEC:
    "marks the CLI's own re-exec under the mise.lock Bun so it never re-execs twice; taken out of the env by the bootstrap, so it never reaches a descendant (cli/bootstrap locked-bun.ts)",
  SKIP_POST_REWRITE:
    "recursion guard the post-rewrite git hook sets for the command it runs (.githooks/post-rewrite)",
  LISTEN:
    "a launcher input; the launcher reads it and passes the gateway -listen",
  APP_COMPONENT:
    "the bundled component a login-service job runs as, written into that job's own definition by login-services (app-component.ts); never inherited from a starter",
  GATEWAY_LABEL:
    "the gateway's login-service label, written into the menu-bar helper's own job by its login-service declaration (menu-bar/login-services) for its Start button; never inherited from a starter",
  RELEASE_DIR:
    "the release self-extractor's cache root, set by the systemd unit and read before the launcher runs (release/cli self-extractor); no runtime reads it",
} as const satisfies Record<string, string>;

type ForwardedKey = keyof typeof RUNTIME_FORWARDED_ENV;
type WithheldKey = keyof typeof RUNTIME_WITHHELD_ENV;
type PrefixKey = keyof typeof RUNTIME_FORWARDED_PREFIXES;

/**
 * One of the app's own environment variables, by key: a declared name, or a
 * declared prefix followed by the rest of the name (`AUTH_GOOGLE_CLIENT_ID`).
 */
export type EnvKey = ForwardedKey | WithheldKey | `${PrefixKey}${string}`;

/** What every name of the app's own variables starts with. */
export const ENV_PREFIX = `${PRODUCT_NAME.toUpperCase()}_`;

/** The name of a key: `EQUIN_<key>`. */
export function envName(key: EnvKey): string {
  return `${ENV_PREFIX}${key}`;
}

/** The key a full name spells, or undefined when it is not one of the app's. */
export function envKeyOf(name: string): string | undefined {
  return name.startsWith(ENV_PREFIX)
    ? name.slice(ENV_PREFIX.length)
    : undefined;
}

/** Every declared key, then every declared prefix — what `launcher:env-names` checks names against. */
export const DECLARED_ENV_KEYS: readonly string[] = [
  ...Object.keys(RUNTIME_FORWARDED_ENV),
  ...Object.keys(RUNTIME_WITHHELD_ENV),
];
export const DECLARED_ENV_PREFIXES: readonly string[] = Object.keys(
  RUNTIME_FORWARDED_PREFIXES,
);

/** True when `name` is a declared key's name, or starts with a declared prefix's. */
export function isDeclaredEnvName(name: string): boolean {
  const key = envKeyOf(name);
  if (key === undefined) return false;
  if (DECLARED_ENV_KEYS.includes(key)) return true;
  return DECLARED_ENV_PREFIXES.some((p) => key.startsWith(p));
}
