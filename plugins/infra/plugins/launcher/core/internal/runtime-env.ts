// What environment does the runtime tree start from?
//
// The runtime tree is the gateway and everything it starts: every backend
// (main, central, each worktree) and Postgres / PgBouncer.
// It used to start from whatever its STARTER happened to carry. The launcher
// spawned the gateway with `{ ...process.env }`, and the gateway handed every
// child its own `os.Environ()` plus a few additions. So `./singularity start`
// run from an agent shell gave every backend on the host that shell's
// SINGULARITY_CONVERSATION_ID, its TMUX socket and its CLAUDE_* session
// variables (observed 2026-09-15). Every op-log record and every commit a
// backend's build made was then stamped with one agent's conversation, and
// tmux clients the backend ran talked to whichever tmux server the starter was
// inside instead of the default one.
//
// So what travels is DECLARED here, as a closed list. The launcher spawns the
// gateway with exactly this subset of its own environment (`pickRuntimeEnv`),
// and passes the names as the gateway's required `-child-env` flag
// (`runtimeEnvNames`). The gateway holds no list of its own: it forwards to its
// children only the names this file declares, plus what it sets per child.
// That makes two boundaries, starter → gateway and
// gateway → child, and one declaration for both.
//
// An allowlist, not a denylist of known-bad names: what a starter's environment
// may carry is an open set, so naming the bad ones only ever catches the last
// leak somebody noticed. The agent pane already works this way, one level
// down: runtime-tmux/server/internal/agent-session-env.ts rebuilds each pane's
// environment from a closed list under `env -i`.
//
// Deliberately NOT on the list:
//
// - Session and terminal state: TMUX*, CLAUDE*, TERM*, WARP_*, SSH_*, XPC_*,
//   SECURITYSESSIONID. They describe the starter's terminal, not the host. The
//   keychain works without them (secrets use the native keyring addon), and
//   agent panes already run `claude` under `env -i`.
// - SOCKET_PATH: a backend's socket is per process, so it travels on the
//   backend's argv (`--socket`), where no descendant inherits it.
// - PG*: the database location is declared in `database.json`. libpq lets the
//   environment win over that file, so a stray PGHOST in the starting shell
//   would silently point a toolbar build's readiness probes at another server.
// - EQUIN_RELEASE_DIR: set by the systemd unit, but read only by the release
//   self-extractor, before the launcher runs. No runtime reads it.
// - Toolchain variables (GOROOT, CARGO_HOME, RUSTUP_*, HOMEBREW_*, __MISE_SHIM):
//   PATH is forwarded, and each tool either defaults these or recomputes them
//   from its own install location.
// - MISE_* (MISE_GLOBAL_CONFIG_FILE above all): a starter's value describes its
//   own shell. The runtime SETS the one it needs, per process, from the checkout
//   that process belongs to — see `toolchainPin` (paths/core).
//
// PATH is the one forwarded name that is not passed through verbatim: mise's
// resolved per-version tool directories are stripped from it and mise's shims
// are put first — located from the environment, so they are there even when the
// starter's shell never activated mise. The runtime tree therefore resolves its
// tools through the shims and obeys the committed `mise.toml` rather than a
// version frozen into (or missing from) the starter's shell. See `runtimePath`.
//
// Every SINGULARITY_* name the code reads or sets must appear in
// RUNTIME_FORWARDED_ENV or RUNTIME_WITHHELD_ENV (or match a forwarded prefix),
// and every name listed here must still be read or set somewhere. The
// `launcher:runtime-env-declared` check enforces both, so a new variable cannot
// be added without deciding whether it travels, and a dead one cannot linger.
// (The retired SINGULARITY_WORKTREE is not listed: the namespace-identity lint
// rule bans that name outright.)
//
// Design: research/2026-09-15-global-declared-runtime-environment.md

/**
 * Facts about the host and the user, passed through from the starter when set
 * and never invented. Under systemd, HOME / USER / LOGNAME / SHELL come from
 * the unit's `User=`.
 */
export const RUNTIME_HOST_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

/**
 * Installation settings that must reach the runtime, each with the reason it
 * travels and who reads it there. Most are set by the release launcher
 * (`launcher/bin/launch.ts`) to point the runtime at the bundle's vendored
 * files; the rest are operator knobs an installation may set once.
 */
export const RUNTIME_FORWARDED_ENV = {
  SINGULARITY_DIR:
    "the data root every path derives from; a release and a preview re-root their whole install with it (paths/core dataRoot(), gateway/main.go flag defaults)",
  SINGULARITY_SOCKETS_DIR:
    "short /tmp dir for backend sockets when the data root is too deep for the AF_UNIX cap; the launcher passes it as -sockets-dir and gateway/main.go reads it as that flag's default",
  SINGULARITY_RELEASE:
    "marks a compiled release, so its single backend takes the host-singleton work (paths/core isRelease())",
  SINGULARITY_RELEASE_RUN_ID:
    "which release run is serving, stamped by the launcher from RELEASE.json for /api/health (paths/core releaseIdentity())",
  SINGULARITY_RELEASE_COMPOSITION:
    "which composition is serving, stamped by the launcher from RELEASE.json for /api/health (paths/core releaseIdentity())",
  SINGULARITY_PG_BIN_DIR:
    "vendored Postgres binaries for the supervised start script (database/embedded/scripts/start.ts)",
  SINGULARITY_PGBOUNCER_BIN:
    "vendored PgBouncer binary for the supervised start script (database/pgbouncer/scripts/start.ts)",
  SINGULARITY_PG_CLIENT_BIN_DIR:
    "vendored pg_dump / pg_restore the backend spawns for DB forks and backups (database/client-tools server/internal/bin.ts)",
  SINGULARITY_PG_PORT:
    "the embedded cluster's port, which a preview moves off the default (database/embedded/shared/internal/paths.ts, database/pgbouncer/scripts/start.ts)",
  SINGULARITY_PG_SOCKET_DIR:
    "short /tmp dir for the Postgres / PgBouncer sockets under a deep release root (database/embedded/shared/internal/paths.ts, database/pgbouncer/shared/internal/paths.ts)",
  SINGULARITY_MIGRATIONS_DIR:
    "the vendored .sql tree, since a compiled backend cannot read its own (database/migrations/server/internal/runner.ts)",
  SINGULARITY_PARCEL_WATCHER_NODE:
    "the vendored @parcel/watcher addon, which `bun --compile` cannot embed (infra/file-watcher shared/engine.ts)",
  SINGULARITY_SENTINEL_WORKER_JS:
    "the vendored cluster-sentinel worker, which `bun --compile` does not trace (debug/sentinel worker-host.ts)",
  SINGULARITY_REPO_CONFIG_DIR:
    "the vendored git-layer config tree for a compiled backend (paths/core repoConfigDir())",
  SINGULARITY_WEB_DIST:
    "the release's vendored web bundle, which the backend reads its build pins from (paths/core webDistDir())",
  SINGULARITY_CLAUDE_BIN:
    "where the backend finds the claude CLI (infra/paths/server bins.ts)",
  SINGULARITY_PROFILING:
    "operator kill-switch for the runtime profiler (infra/runtime-profiler/core recorder.ts)",
  SINGULARITY_NO_SPAWN_PRIORITY:
    "operator escape hatch that turns off darwinbg demotion of background work (packages/spawn-priority background.ts)",
  SINGULARITY_NO_SIGNAL_ORIGIN:
    "operator escape hatch that turns off the native signal-origin tap (packages/signal-origin signal-origin.ts)",
  SINGULARITY_HEAVY_READ_LOCAL_CONCURRENCY:
    "operator tuning for the per-backend heavy-read gate (infra/host/host-read-pool pool.ts)",
} as const satisfies Record<`SINGULARITY_${string}`, string>;

/**
 * Name PREFIXES that travel: every variable starting with one is forwarded.
 * Passed to the gateway as `<prefix>*`.
 */
export const RUNTIME_FORWARDED_PREFIXES = {
  SINGULARITY_AUTH_:
    "operator-set OAuth client credentials, SINGULARITY_AUTH_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET, read by central (auth/google, auth/notion central descriptor.ts)",
} as const satisfies Record<`SINGULARITY_${string}`, string>;

/**
 * Third-party tool locations an operator may set, where the install-time
 * reader and the run-time reader must agree. None today:
 * `PLAYWRIGHT_BROWSERS_PATH` left when Chromium became an `infra/deps`
 * dependency, which installs into its own cache dir and launches the
 * executable it recorded there, whatever the environment says.
 */
export const RUNTIME_FORWARDED_TOOL_ENV: Readonly<Record<string, string>> = {};

/**
 * Names that exist in the code but must NEVER be inherited by the runtime tree,
 * each with who delivers it instead. A backend that inherited one of these
 * would act as whichever process happened to start the gateway.
 */
export const RUNTIME_WITHHELD_ENV = {
  SINGULARITY_CONVERSATION_ID:
    "agent-session identity; the tmux runtime delivers it into that agent's own pane with `tmux -e`, where the commit hook and op-log read it",
  SINGULARITY_TOOL_USE_ID:
    "the Bash tool call an e2e script was launched by; a PreToolUse guard exports it into that one command, never a backend's",
  SINGULARITY_PARENT_HOST:
    "the host an agent's MCP client dials back to; delivered into that agent's own pane with `tmux -e`",
  SINGULARITY_PARENT_LIFELINE:
    "the lock file one spawn holds for the child it starts, set by infra/spawn for that child only (packages/flock lifeline.ts)",
  SINGULARITY_HOST_GRANT:
    "a host CPU admission grant, set by a grant holder for the subprocess it spawns (infra/host/host-admission grant.ts)",
  SINGULARITY_LANE:
    "the admission lane of a CLI op, set by the op for the subprocesses it spawns (cli/op-runtime lane.ts)",
  SINGULARITY_BUILD_ID:
    "the build_runs row a UI-triggered build writes to, set by the backend for the build it spawns (build/server run-build.ts)",
  SINGULARITY_BUILD_DETACHED:
    "marks a supervised build that must outlive its backend, set by the backend for the build it spawns (build/server run-build.ts)",
  SINGULARITY_BUILD_IN_PROGRESS:
    "marks the check pass a build spawns, set by that build (tooling/checks/core run-context.ts)",
  SINGULARITY_CHECK_JOBS:
    "check fan-out width for one check run, typed by whoever runs it; reaches that run's subprocesses, never a backend",
  SINGULARITY_CHECK_NO_CACHE:
    "cache bypass for one check run, typed by whoever runs it; reaches that run's subprocesses, never a backend",
  SINGULARITY_CHECK_SHADOW:
    "shadow-mode switch for one check run, typed by whoever runs it; reaches that run's subprocesses, never a backend",
  SINGULARITY_DEPS_REEXEC:
    "re-exec budget the CLI carries across its own dependency-install re-exec; taken out of the env by the bootstrap, so it never reaches a descendant (cli/bootstrap reexec.ts)",
  SINGULARITY_LOCKED_BUN_REEXEC:
    "marks the CLI's own re-exec under the mise.lock Bun so it never re-execs twice; taken out of the env by the bootstrap, so it never reaches a descendant (cli/bootstrap locked-bun.ts)",
  SINGULARITY_SKIP_POST_REWRITE:
    "recursion guard the post-rewrite git hook sets for the command it runs (.githooks/post-rewrite)",
  SINGULARITY_LISTEN:
    "a launcher input; the launcher reads it and passes the gateway -listen",
} as const satisfies Record<`SINGULARITY_${string}`, string>;

const HOST_NAMES: ReadonlySet<string> = new Set(RUNTIME_HOST_ENV);
const FORWARDED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(RUNTIME_FORWARDED_ENV),
  ...Object.keys(RUNTIME_FORWARDED_TOOL_ENV),
]);
const FORWARDED_PREFIXES: readonly string[] = Object.keys(
  RUNTIME_FORWARDED_PREFIXES,
);

/** True when `name` is part of the declared runtime environment. */
export function isRuntimeEnvName(name: string): boolean {
  return (
    HOST_NAMES.has(name) ||
    FORWARDED_NAMES.has(name) ||
    FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * A directory mise creates when it installs one version of one tool, e.g.
 * `~/.local/share/mise/installs/bun/1.4.2/bin` or `…/installs/tmux/3.6a`. The
 * version is part of the path, so the entry names ONE build forever.
 */
const MISE_INSTALL_DIR = /(^|\/)mise\/installs\//;

/** mise's own dispatcher directory, which resolves a tool per invocation. */
const MISE_SHIMS_DIR = /(^|\/)mise\/shims\/?$/;

/**
 * Where mise keeps its shims for the user `env` describes, by mise's own lookup
 * order: `$MISE_DATA_DIR`, else `$XDG_DATA_HOME/mise`, else
 * `$HOME/.local/share/mise`, then `/shims`. Read from the environment, NOT from
 * PATH: mise puts the shims there whether or not any shell ever ran
 * `mise activate`. Undefined only when not even HOME is set.
 *
 * Says where they WOULD be; whether mise has created them is the caller's
 * question (this module does no I/O).
 */
export function miseShimsDir(
  env: Record<string, string | undefined>,
): string | undefined {
  const dataDir =
    env.MISE_DATA_DIR ||
    (env.XDG_DATA_HOME ? `${env.XDG_DATA_HOME}/mise` : undefined) ||
    (env.HOME ? `${env.HOME}/.local/share/mise` : undefined);
  if (dataDir === undefined) return undefined;
  return `${dataDir.replace(/\/+$/, "")}/shims`;
}

/**
 * The runtime's PATH for environment `env`: its PATH with mise's resolved tool
 * directories removed and mise's shims FIRST.
 *
 * A shell with mise activated does not put mise's shims on PATH and leave it
 * there — it puts the RESOLVED directory of each tool version in front of them.
 * That is right for a shell, which is re-activated per directory, and wrong for
 * the runtime tree, which is one long-lived daemon: `./singularity start`
 * snapshots the starter's PATH into the gateway, and every backend it ever
 * spawns resolves `bun` against that snapshot. So the version baked into the
 * snapshot outlives any later change to `mise.lock`.
 *
 * That is not hypothetical. On 2026-09-16 the gateway was still handing every
 * backend `…/mise/installs/bun/latest/bin`, a symlink resolved once in May, so
 * the whole runtime tree ran Bun 1.3.13 — the version that double-closes a
 * finished child's extra stdio fds and killed pooled Postgres sockets mid-query
 * — and reading `mise.toml` told you nothing about it.
 *
 * Dropping those entries leaves the shims, which re-resolve per invocation from
 * the `mise.toml` + `mise.lock` of the directory the process runs in.
 *
 * The shims then go to the FRONT. The same day showed the other half of the
 * hole: the gateway's PATH listed `/opt/homebrew/bin` and `~/.cargo/bin` ahead
 * of the shims, so the runtime ran Homebrew's tmux and rustup's default rust
 * while `mise.toml` declared versions nothing used.
 *
 * And the shims are there even when the starter's PATH never mentioned mise —
 * a shell that installed mise but never activated it, or a service unit. The
 * 2026-09-18 clean-VM run was that case: the PATH came back unchanged, tmux and
 * rustc were simply absent, and the toolchain check failed the build. So the
 * shims directory comes, strongest first, from: an explicit `…/mise/shims`
 * entry (the one the starter's own mise uses), one derived from a stripped
 * `…/mise/installs/…` entry, or `miseShimsDir(env)`. A machine with no mise at
 * all gets one entry that does not exist, which costs nothing.
 *
 * It takes the whole environment rather than a PATH string on purpose: where
 * mise lives is part of the answer, so no caller can compute a runtime PATH
 * without it. Idempotent — once the shims are on PATH they are rule one, so a
 * child that does not inherit MISE_DATA_DIR still gets the same PATH back.
 */
export function runtimePath(env: Record<string, string | undefined>): string {
  const { shims, kept } = splitPath(env);
  if (shims === undefined) return env.PATH ?? "";
  return [shims, ...kept].join(":");
}

/**
 * The mise shims directory `runtimePath(env)` puts first — the one the runtime
 * resolves its tools through — or undefined when it puts none. Whether it
 * exists on disk is the caller's question.
 */
export function runtimeShimsDir(
  env: Record<string, string | undefined>,
): string | undefined {
  return splitPath(env).shims;
}

function splitPath(env: Record<string, string | undefined>): {
  shims: string | undefined;
  kept: string[];
} {
  const value = env.PATH ?? "";
  const kept: string[] = [];
  let explicit: string | undefined;
  let derived: string | undefined;
  for (const entry of value === "" ? [] : value.split(":")) {
    if (MISE_SHIMS_DIR.test(entry)) {
      explicit ??= entry;
      continue;
    }
    const at = entry.search(MISE_INSTALL_DIR);
    if (at < 0) {
      kept.push(entry);
      continue;
    }
    const root = entry.slice(0, at);
    derived ??= `${root}${root.endsWith("/") ? "" : "/"}mise/shims`;
  }
  return { shims: explicit ?? derived ?? miseShimsDir(env), kept };
}

/**
 * The declared part of `source`: every host, forwarded or tool name, and every
 * name starting with a forwarded prefix, whose value is set. Anything else —
 * withheld names and names this file has never heard of alike — is dropped.
 *
 * PATH is the one value that is not passed through verbatim: see
 * `runtimePath`. It is normalised HERE, at the filter every runtime
 * environment goes through, rather than at the one call site — a second caller
 * must not be able to hand the gateway a PATH that pins a tool version.
 *
 * Takes the environment as an argument rather than reading `process.env`, so
 * the caller decides which environment it filters (the launcher passes its
 * LIVE `process.env`, mutations included) and a test can pass a plain record.
 */
export function pickRuntimeEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!isRuntimeEnvName(name)) continue;
    picked[name] = name === "PATH" ? runtimePath(source) : value;
  }
  return picked;
}

/**
 * Only the host facts of `source` (RUNTIME_HOST_ENV) whose value is set: the
 * environment for a third-party tool the runtime runs, which needs to know who
 * and where the user is and nothing about this installation. Narrower than
 * `pickRuntimeEnv` on purpose — that one also carries the SINGULARITY_*
 * installation settings and OAuth client credentials, which a tool like the
 * claude CLI has no business seeing.
 */
export function pickHostEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of RUNTIME_HOST_ENV) {
    const value = source[name];
    if (value === undefined) continue;
    // Same rule as `pickRuntimeEnv`: a tool the runtime runs must not inherit a
    // PATH that freezes one version of a toolchain. Idempotent, so a PATH the
    // gateway already normalised passes through unchanged.
    picked[name] = name === "PATH" ? runtimePath(source) : value;
  }
  return picked;
}

/**
 * Every declared name, with each prefix spelled `<prefix>*` — the value of the
 * gateway's `-child-env` flag (joined with commas), which tells the gateway
 * which of its own variables its children may see.
 */
export function runtimeEnvNames(): string[] {
  return [
    ...RUNTIME_HOST_ENV,
    ...Object.keys(RUNTIME_FORWARDED_ENV),
    ...Object.keys(RUNTIME_FORWARDED_TOOL_ENV),
    ...FORWARDED_PREFIXES.map((prefix) => `${prefix}*`),
  ];
}
