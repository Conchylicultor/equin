# Sync fs takes only an app-owned path (`AppPath`)

Task: task-1793455067 ("UserPath freeze protection is opt-in: an unmarked user
path is never checked"). Follows `research/2026-10-30-apps-sonata-midi-folder-probe-off-the-js-thread.md`
and the `UserPath` / `user-path/no-sync-fs` work of 600757d48c.

## Problem

A synchronous fs call on a path in a folder macOS gates behind Files & Folders
(Downloads, Documents, Desktop, removable / network volumes) blocks the
backend's JS thread while the permission prompt is up — 5.5 h on 2026-10-11.

600757d48c made `UserPath` a brand and refused a sync fs call on a branded
value. That is a **deny-list**: protection exists only where someone
remembered to mark the path. A user path arriving as a plain `string` — an
endpoint body, a new config field, a file-watcher event inside a user folder,
a value laundered through `String()` or an object field — is invisible. The
rule only caught *dropping* a mark (`widened`), never a *missing* one.

## Options

1. **Brand every entry point** (endpoints, config, watchers) as `UserPath`.
   Enumerating entry points is open-ended: nothing tells a `z.string()` field
   that it holds a path. Still opt-in, one level up.
2. **Ban sync fs on backend threads.** ~430 call sites in `server/` /
   `machine/` / `central/` alone, many in sync contexts (boot, module eval,
   locks). Out of proportion: almost all of them read the app's own files.
3. **Invert the proof (chosen).** A sync fs call in runtime code takes only a
   path **proven app-owned**. An unmarked `string` is unproven, so a user path
   that nobody marked is refused by default — the guarantee holds by
   construction, and the only way past it is an explicit, greppable claim.

## Design

- `AppPath` (user-path core): `string & z.$brand<"AppPath">`, with
  `asAppPath` (a claim, made where the app makes the path), `joinAppPath(dir,
  ...segments)` (a path under an app-owned one stays app-owned) and
  `AppPathSchema` (an app-owned path read from a record the app wrote).
- **Sources are branded once**: `infra/paths` — `REPO_ROOT`, `PLUGINS_DIR`,
  the data root, `worktreesDir()` / `worktreeDataDir()` / `worktreeArtifacts.*`,
  `webDistDir()`, backups dirs, the Claude dirs — and every `DataDir` /
  `DataDirArea` (`.path`, `.file()`, `.ensure()`). Everything derived through
  types follows.
- `user-path/no-sync-fs`, rewritten as an allow-list, in runtime folders
  (`server/`, `machine/`, `central/`, `core/`, `shared/`; tests, `cli/`,
  `scripts/`, `bin/`, `e2e/` are out of scope by the lint's defaults and
  categories). For every `PathLike` argument of a `node:fs` `*Sync` call
  (descriptors and a symlink's target text skipped):
  - **user** — it is (built from) a `UserPath`;
  - **unproven** — it is not proven app-owned;
  - **launder** — `asAppPath(userPath)` or `userPath as AppPath`.
- **Proven app-owned**: `AppPath` type (every non-nullish union member); a
  non-empty string literal; `import.meta.dir` / `.dirname` / `.path` /
  `.filename`, `__dirname`, `process.execPath`, `process.cwd()`, `tmpdir()`,
  `fileURLToPath(…)`, `mkdtemp(Sync)`; `join` / `normalize` / `dirname` whose
  first argument is proven; `resolve` whose every argument is; a template or
  `+` whose head is a literal or a proven expression; `realpath` / `readlink`
  of a proven path; both arms of a branch; `await` / casts; a file-local
  `const` bound to one.
- **Deliberately not proven**: the home dir (`homedir()`, `HOME_DIR`) and env
  vars — `join(home, rest)` is wherever `rest` says, Downloads included. A path
  under home the app owns (`~/.claude`, the data root) is an explicit claim at
  its one definition.
- `widened` is gone: dropping the `UserPath` brand now makes the path
  unproven, which the sync check already refuses.

Known limits (documented in the plugin): `..` inside a segment joined under an
app root; a claim (`asAppPath`) is trusted — it is the reviewable seam; Bun
sync APIs (`Bun.file().size`, sqlite) and child processes are not covered.

## Migration

~930 reports at first run (~200 files); branding `infra/paths` and data dirs
removed ~150. The rest are fixed by typing parameters / returns / fields
`AppPath` along each chain back to its source, `joinAppPath` for derived
paths, and `asAppPath` only at a real app-owned source the types cannot
follow (a checkout root, a value read from a file the app wrote, an env var
the app sets), each with its reason.

## v2 — claims are declared, not free (2026-11-02)

A first migration pass (agents, ~280 files) showed the risk: with a free
`asAppPath`, a claim is the cheapest way past a report, and agents reached for
`asAppPath(root)` on whatever a caller passed — 86 claims and growing, most
unverified. Measured alternatives (967 sync calls in runtime folders, 639 of
them inside sync functions): banning sync fs outright would make ~640 call
chains async (lock helpers, `DataDir.ensure()`, the duress latch, exit hooks)
and still not remove the hazard — an async call parked on a pending prompt
holds one of libuv's four threadpool threads. Decision (supervisor): the
hybrid.

- `asAppPath(x)` is policed by a second rule, `user-path/no-unproven-claim`:
  when the shared provenance model proves `x` (a temp dir, a derivation of an
  `AppPath`, a literal), it only types; otherwise it is a CLAIM, refused
  unless the file declares it as a `sanctioned` exemption (the rule is
  `noDebt`) with its reason. Every claim is listed by `./equin exempt list
  --rule user-path/no-unproven-claim`.
- Named sources replace scattered claims: `infra/paths` and data dirs, the git
  roots (`infra/spawn`), `readEnvPath` (`env-names`) for the app's own env vars.
- `AppPathSchema` is gone (a schema branding whatever JSON says is a claim the
  lint cannot see); `joinAppPath` is a pure POSIX join (`core/` may not import
  `node:path`), held to `node:path`'s `join` by its test.
- A value read from a request, a database record or a watcher event is never
  claimed: it is read async, or its field is typed where the app writes it.
- `cli/`, `scripts/`, `bin/`, `provision/` are out of both rules' scope: they
  never run on a backend's thread.

### Review follow-ups closed in the same change

- **Unproven tails.** A join, template or `+` under a proven root is proven
  only when every later part is a safe tail (a literal, a literal-typed or
  number value, or a proven path). A plain-string tail goes through
  `joinAppPath`, which throws on a `..` segment; `appPathParent` is the one
  way up. Spread arguments and `mkdtemp` of an unproven prefix prove nothing;
  `mkdtempSync` / `cpSync` / `globSync`'s plain-`string` path parameters are
  checked.
- **Git-listed worktrees.** `WorktreeEntry.path` is a plain string;
  `appCheckoutOf` re-derives the app's own checkout (main, or one under
  `.claude/worktrees/`) for the readers that need one (the deps sweep, the
  agent browser's target, the review pane's plugin changes); only the main
  worktree root is claimed.
- **Claim bypasses.** `no-unproven-claim` resolves `asAppPath` by declaration
  (an aliased import), reports it handed on as a value (`.map(asAppPath)`) and
  checks `<AppPath>x` casts.
