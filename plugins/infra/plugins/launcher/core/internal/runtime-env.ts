// What environment does the runtime tree start from?
//
// The runtime tree is the gateway and everything it starts: every backend
// (main, central, each worktree) and Postgres / PgBouncer.
// It used to start from whatever its STARTER happened to carry. The launcher
// spawned the gateway with `{ ...process.env }`, and the gateway handed every
// child its own `os.Environ()` plus a few additions. So `./equin start`
// run from an agent shell gave every backend on the host that shell's
// conversation id and its CLAUDE_* session
// variables (observed 2026-09-15). Every op-log record and every commit a
// backend's build made was then stamped with one agent's conversation.
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
// leak somebody noticed. An agent process already works this way, one
// level down: agent-launch rebuilds each agent's environment from a closed
// allowlist.
//
// Deliberately NOT on the list:
//
// - Session and terminal state: CLAUDE*, TERM*, WARP_*, SSH_*, XPC_*,
//   SECURITYSESSIONID. They describe the starter's terminal, not the host. The
//   keychain works without them (secrets use the native keyring addon), and
//   agent processes start from their own allowlisted environment.
// - SOCKET_PATH: a backend's socket is per process, so it travels on the
//   backend's argv (`--socket`), where no descendant inherits it.
// - PG*: the database location is declared in `database.json`. libpq lets the
//   environment win over that file, so a stray PGHOST in the starting shell
//   would silently point a toolbar build's readiness probes at another server.
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
// The app's own variables are declared by KEY in the `env-names` sub-plugin (forwarded,
// withheld, forwarded prefixes), each named `EQUIN_<key>`. `launcher:env-names`
// keeps the declaration closed: no full name spelled in TypeScript code, no
// undeclared name in a mirror (Go, shell, JSON) or a doc, no key nothing uses.
//
// Design: research/2026-09-15-global-declared-runtime-environment.md,
// research/2026-10-25-global-equin-env-vars.md (by key)

import {
  RUNTIME_FORWARDED_ENV,
  RUNTIME_FORWARDED_PREFIXES,
  envKeyOf,
  envName,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * Facts about the host and the user, passed through from the starter when set
 * and never invented. Under systemd, HOME / USER / LOGNAME / SHELL come from
 * the unit's `User=`.
 *
 * `CREDENTIALS_DIRECTORY` is systemd's too: where it decrypted the unit's
 * `LoadCredentialEncrypted=` credentials (a deployed box's deploy secrets,
 * read by `apps/deploy/deploy-secrets`' `readDeploySecret`). A path, never a
 * value — the secrets stay files the backend opens on purpose, so no child
 * process inherits one. Unset everywhere but a deployed box.
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
  "CREDENTIALS_DIRECTORY",
] as const;

/**
 * Third-party tool locations an operator may set, where the install-time
 * reader and the run-time reader must agree. None today:
 * `PLAYWRIGHT_BROWSERS_PATH` left when Chromium became an `infra/deps`
 * dependency, which installs into its own cache dir and launches the
 * executable it recorded there, whatever the environment says.
 */
export const RUNTIME_FORWARDED_TOOL_ENV: Readonly<Record<string, string>> = {};

const HOST_NAMES: ReadonlySet<string> = new Set([
  ...RUNTIME_HOST_ENV,
  ...Object.keys(RUNTIME_FORWARDED_TOOL_ENV),
]);
const FORWARDED_KEYS: ReadonlySet<string> = new Set(
  Object.keys(RUNTIME_FORWARDED_ENV),
);
const FORWARDED_PREFIXES: readonly string[] = Object.keys(
  RUNTIME_FORWARDED_PREFIXES,
);

/** True when `name` is a forwarded key's name, or starts with a forwarded prefix's. */
function isForwardedName(name: string): boolean {
  const key = envKeyOf(name);
  if (key === undefined) return false;
  return (
    FORWARDED_KEYS.has(key) || FORWARDED_PREFIXES.some((p) => key.startsWith(p))
  );
}

/** True when `name` is part of the declared runtime environment. */
export function isRuntimeEnvName(name: string): boolean {
  return HOST_NAMES.has(name) || isForwardedName(name);
}

/**
 * A directory mise creates when it installs one version of one tool, e.g.
 * `~/.local/share/mise/installs/bun/1.4.2/bin` or `…/installs/rust/1.99.1`. The
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
 * the runtime tree, which is one long-lived daemon: `./equin start`
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
 * of the shims, so the runtime ran rustup's default rust
 * while `mise.toml` declared versions nothing used.
 *
 * And the shims are there even when the starter's PATH never mentioned mise —
 * a shell that installed mise but never activated it, or a service unit. The
 * 2026-09-18 clean-VM run was that case: the PATH came back unchanged and
 * rustc was simply absent, and the toolchain check failed the build. So the
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
    if (HOST_NAMES.has(name)) {
      picked[name] = name === "PATH" ? runtimePath(source) : value;
      continue;
    }
    if (isForwardedName(name)) picked[name] = value;
  }
  return picked;
}

/**
 * Only the host facts of `source` (RUNTIME_HOST_ENV) whose value is set: the
 * environment for a third-party tool the runtime runs, which needs to know who
 * and where the user is and nothing about this installation. Narrower than
 * `pickRuntimeEnv` on purpose — that one also carries the app's own
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
    ...(
      Object.keys(
        RUNTIME_FORWARDED_ENV,
      ) as (keyof typeof RUNTIME_FORWARDED_ENV)[]
    ).map(envName),
    ...Object.keys(RUNTIME_FORWARDED_TOOL_ENV),
    ...(FORWARDED_PREFIXES as (keyof typeof RUNTIME_FORWARDED_PREFIXES)[]).map(
      (prefix) => `${envName(prefix)}*`,
    ),
  ];
}
