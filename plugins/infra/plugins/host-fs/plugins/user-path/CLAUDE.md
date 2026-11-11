# user-path

Which host paths a **synchronous** fs call may touch. A path in a folder macOS
gates behind Files & Folders (Downloads, Documents, Desktop, removable and
network volumes) blocks a sync call on it — and the backend's whole JS thread
— until someone answers macOS's "allow access?" prompt: on 2026-10-11 one
`realpathSync` of `~/Downloads` froze main for 5.5 h
(`research/2026-10-30-apps-sonata-midi-folder-probe-off-the-js-thread.md`).

Two brands (core), both a plain `string` at runtime:

- **`AppPath`** — a path the app owns: its data dirs, its checkout, a temp dir
  it minted, a fixed system path. The **only** path a sync fs call in runtime
  code may take. `joinAppPath(dir, ...names)` builds one under another;
  `asAppPath(x)` types one (see the claim rule below).
- **`UserPath`** — a path the user (or their config) chose, branded with
  `asUserPath` (a `dirPathField`'s schema reads one). Never an `AppPath`.

The check is an **allow-list**: a path nobody proved is refused, so a user
path that arrives as a plain string (an endpoint body, a new config field, a
watcher event) is safe by construction — nobody has to remember to mark it.
Design: `research/2026-10-31-global-sync-fs-app-path.md`.

## Where `AppPath` comes from

- **Named sources** — `infra/paths/repo-root` (`REPO_ROOT`); `infra/paths` (`PLUGINS_DIR`, the data
  root, `worktreesDir()` / `worktreeDataDir()` / `worktreeArtifacts.*`,
  `webDistDir()`, `repoConfigDir()`, the backups dirs, `CLAUDE_*`, every data
  dir's `.path` / `.file()` / `.ensure()` and `subdir()` area); `infra/spawn`'s
  `getWorktreeRoot()` / `getMainRepoRoot()`; `env-names`' `readEnvPath(key)`
  for the app's own env vars.
- **Types** — a parameter, return or field declared `AppPath` carries the
  proof across files; declare it where a function takes a path it reads
  synchronously, and the obligation moves to its callers, up to a source.
- **Derivations the rule proves** — `asAppPath(x)` only gives tsc the type
  when `x` is proven (below): `${p}.tmp`, `dirname(p)`, `realpathSync(p)` of an
  `AppPath`, `mkdtempSync(join(tmpdir(), …))`, `import.meta.dir`, a literal.
- **Declared claims** — anything else (a home-relative dir, a path the OS
  fixes, a file of the app's own `node_modules`, a record the app wrote) is a
  claim, made only by a file whose plugin declares it: a `sanctioned`
  exemption of `user-path/no-unproven-claim` in its `exempt/index.ts`, with
  the reason the path is the app's. `./equin exempt list --rule
  user-path/no-unproven-claim` lists every claim. A value read from a request,
  a database record or a watcher event is never claimed: read it async, or
  type the field where the app writes it.

`UserPath` comes from a `dirPathField` value (`fields/directory-path`) and
host-fs's `resolveHostPath` / `resolveOrRefuse` / `resolvedOrNull`; every
host-fs read below the resolve takes one, and is async.

## The lints

Type-aware, so the proof is the TYPE and crosses files through declarations
only (a type-aware rule may not read another file's source —
`research/2026-10-17-global-lint-keyed-on-what-it-reads.md`). Both run in
runtime code (`server/`, `machine/`, `central/`, `core/`, `shared/`; not
`cli/`, `scripts/`, `bin/`, `provision/` or tests, which never run on a
backend's thread), and share one provenance model (`lint/provenance.ts`).

**`user-path/no-sync-fs`** — every path argument of a `node:fs` `*Sync` call
(a descriptor and a symlink's target text are not paths read):

- **user** — it is, or is built from, a `UserPath`;
- **unproven** — it is not proven app-owned.

**`user-path/no-unproven-claim`** (sanctioned exemptions only, no debt) —
`asAppPath(x)` / `x as AppPath`:

- **claim** — `x` is not proven app-owned and the file declares no claim;
- **launder** — `x` is a `UserPath` (never claimable, exempt or not).

Proven app-owned: the `AppPath` type (every non-nullish member of a union); a
non-empty string literal; `import.meta.dir` / `.dirname` / `.path` /
`.filename`, `__dirname`, `process.execPath`, `process.cwd()`, `tmpdir()`,
`fileURLToPath(…)`, `mkdtemp(Sync)` of a proven prefix; `join` / `normalize`
/ `dirname` of a proven first argument whose every later argument is a safe
tail; `resolve` of proven arguments only (an absolute later one replaces the
root); a template or `+` whose head is a literal or proven and whose every
later part is a safe tail; `realpath` / `readlink` of a proven path; both
arms of a branch; `await` and casts; a `const` of the file bound to one. A
**safe tail** is text the app's code wrote — a literal, a literal-typed or
number value — or a proven path; a plain `string` (an id, a name read from a
dir, a stored row's field) is not, since a `..` in it climbs out of the root:
join one with `joinAppPath`, which refuses that at run time. A spread argument
proves nothing. Not the home dir or an env var: `join(home, rest)` is wherever
`rest` says.

Git-listed worktrees are not app paths either: `git worktree list` names a
repo's worktrees wherever their owner put them, so `WorktreeEntry.path` is a
plain string and `appCheckoutOf(path)` (`infra/worktree`) re-derives the
app's own checkout (main, or one under `.claude/worktrees/`) — `null` for any
other.

The fix for a `no-sync-fs` report is, in order: type the path `AppPath` back
to its source; or, for a path that may really be the user's, the async call,
bounded so no caller waits on the prompt — the pattern is Sonata's MIDI
folders (`createFolderStatusStore`: probes deduplicated per path, a refresh
waits `PROBE_ANSWER_MS`, a folder still unanswered reads `checking` and
publishes its answer when it lands). host-fs is already async throughout.
Async alone is not the whole fix for a user path: a call parked on a pending
prompt holds one of libuv's four threadpool threads.

**Not covered**: a wrong declared claim (it is reviewed where it is
declared); sync APIs outside `node:fs` (Bun's, sqlite, a child process);
out-of-scope folders; a `*Sync` function re-exposed under a property not
named `*Sync` / `native` (`o.read = readFileSync; o.read(p)`) — a member call
is resolved only when its name can be one, so the checker types only the
candidate calls (an identifier callee — an alias, a twin — is always asked).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Which host paths a synchronous fs call may touch: AppPath (a path the app owns — its data dirs, its checkout; the only kind a sync fs call in runtime code may take) and UserPath (one the user or their config chose), with the type-aware lint that refuses a sync fs call on any path not proven app-owned — so a macOS Files & Folders prompt can never freeze a backend's JS thread, whether or not anyone marked the user's path.
- Cross-plugin:
  - Imported by: 105 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×36
    - `framework` ×20
    - `apps` ×8
    - `debug` ×7
    - `packages` ×6
    - `plugin-meta` ×5
    - `config_v2` ×3
    - `database` ×3
    - `release` ×3
    - `code-explorer` ×2
    - `fields` ×2
    - `primitives` ×2
    - `backup/sources/project-memory`
    - `conversations/runtime-sdk`
    - `integrations/youtube/audio-fetch`
    - `menu-bar`
    - `reports/outbox`
    - `review/plugin-changes`
    - `toolchain`
    - `ui/icons/icon-sets`
- Exemptions:
  - Exempts itself from: `user-path/no-unproven-claim` — `core/internal/user-path.ts` (sanctioned)
  - Exempted by:
    - `apps/deploy/deploy-secrets` (0 debt)
    - `debug/paging-probe` (0 debt)
    - `debug/sentinel` (0 debt)
    - `framework/tooling/checks` (0 debt)
    - `framework/tooling/checks/type-check` (0 debt)
    - `framework/tooling/codegen` (0 debt)
    - `framework/tooling/guards` (0 debt)
    - `framework/tooling/import-closure` (0 debt)
    - `framework/tooling/web-artifacts` (0 debt)
    - `infra/claude-cli/sdk` (0 debt)
    - `infra/deps/playwright-browser` (0 debt)
    - `infra/git/tree-lock` (0 debt)
    - `infra/host-fs/user-path` (0 debt)
    - `infra/launcher/env-names` (0 debt)
    - `infra/launcher/login-services` (0 debt)
    - `infra/paths` (0 debt)
    - `infra/paths/repo-root` (0 debt)
    - `infra/spawn` (0 debt)
    - `infra/worktree` (0 debt)
    - `packages/signal-origin` (0 debt)
    - `toolchain` (0 debt)
- Core:
  - Exports (types):
    - `AppPath`
    - `UserPath`
  - Exports (values):
    - `appPathParent`
    - `asAppPath`
    - `asUserPath`
    - `joinAppPath`

<!-- AUTOGENERATED:END -->
