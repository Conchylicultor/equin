# Runtime tool resolution outside a checkout

## Context

`runtimePath` (`plugins/infra/plugins/launcher/core/internal/runtime-env.ts`) puts mise's shims first on every
runtime process's PATH. Since `6bbdd9c3d` that holds even for starters that never activated mise. A shim resolves its
version from the `mise.toml` + `mise.lock` found by walking up from its **cwd**. The question: what happens when a
runtime process runs a mise tool from a cwd with no `mise.toml` above it?

### What a shim actually does with no version for its cwd (measured, cwd `/private/tmp`)

| tool  | result |
|-------|--------|
| tmux  | ran `/opt/homebrew/bin/tmux` 3.6a: mise falls through to the next copy of the tool on PATH **when one exists** |
| bun, go, rustc, cargo | `mise ERROR No version is set for shim: <tool>`: no copy outside mise, so there is nothing to fall through to |

So the old comment was half true. With no version set, a shim either runs some **unlocked** system copy or errors.
Neither one is "the version `mise.lock` says".

### Does any runtime spawn do this today? No, but only by accident of layout

Inventory of every runtime spawn of a mise tool by name:

| spawn | tool | cwd | in a checkout? |
|---|---|---|---|
| gateway → backend (`gateway/worktree.go`, `cmd.Dir = spec.Server`) | bun | `spec.Server` | yes |
| gateway supervisor → PG/PgBouncer start (`launcher/server/internal/boot.ts:293`) | bun | inherited: gateway cwd `<repoRoot>/gateway` | yes (a release uses compiled binaries) |
| launcher `go build` (`boot.ts:405`) | go | `<repoRoot>/gateway` | yes (dev only) |
| tmux client calls (`runtime-tmux/server/internal/tmux-runtime.ts`, `paths/server/internal/bins.ts` `TMUX` = the shim's path) | tmux | inherited: backend cwd | yes |
| supervised jobs / toolbar build / deploy legs (`./equin …` → `exec bun`) | bun | explicit `REPO_ROOT` | yes |
| `release/cli` `go build` | go | `<checkout>/gateway` | yes |
| release preview `launch`, `claude --print` (`cwd: "/tmp"`) | none by name | outside | n/a |

Every mise-tool spawn sits in a checkout because every cwd happens to be one: a backend's `spec.Server`,
`REPO_ROOT`, or a worktree, which lives *under* main at `.claude/worktrees/`, so the walk up reaches main's
`mise.toml` too. Nothing enforces it. The first spawn with a cwd under `~/.singularity/…`, `/tmp`, an attachment dir or
a backup staging dir will either silently run Homebrew's tmux or crash with the mise error. One latent case already
exists: `claude --print` runs at `/tmp` with the shims-first PATH, so any tool or hook it runs would hit this.

## Decision: outside a checkout, a runtime process resolves tools exactly as its OWN checkout would

It should not fall back to a system copy. That is the unlocked-version drift that putting the shims first was meant to
remove (Homebrew's tmux, rustup's default rust). It should not stay an error either, because a cwd is incidental to
which toolchain a process belongs to. A process belongs to one checkout, and that checkout's `mise.lock` is the
answer wherever the process happens to stand.

### Mechanism: `MISE_GLOBAL_CONFIG_FILE=<checkout>/mise.toml`

This tells mise to use that file as the **global** config, which is the fallback when no local config is found on the
walk up. Measured on this machine:

- cwd `/private/tmp`, global = a probe `mise.toml` whose `mise.lock` pins go 1.24.13 → `go1.24.13`. The sibling
  **lock is honoured**, not just `latest`.
- cwd inside a worktree, global = main's `mise.toml` → the worktree's own lock wins (local beats global). A worktree
  trialling a toolchain upgrade is unaffected.
- `~/.config/mise/config.toml` is still loaded alongside it (debug trace), so the `trusted_config_paths` setting
  that keeps worktree configs trusted still applies. No trust regressions.
- A global config needs no `mise trust`.

So the variable changes behaviour **only** where resolution currently fails or drifts. Inside a checkout nothing moves.

## Changes

### 1. `launcher/core/internal/runtime-env.ts`: one declaration of the pin
- Add `toolchainPin(checkoutRoot: string): { MISE_GLOBAL_CONFIG_FILE: string }`, next to `runtimePath`. It is a pure
  function. The doc comment gives the rule above and the measurements.
- In the header's "Deliberately NOT on the list" section, name `MISE_GLOBAL_CONFIG_FILE`/`MISE_*`: the **starter's**
  value is never forwarded (it is the starter's shell's accident). The runtime *sets* its own per process.
- Export it from the `launcher/core` barrel.

### 2. Each backend pins itself at entry
- `plugins/framework/plugins/server-core/bin/`: a `pin-toolchain.ts` imported right after `declare-namespace.ts`
  does `Object.assign(process.env, toolchainPin(<this backend's checkout root>))`. It uses the canonical
  `getWorktreeRoot()` (`infra/spawn`) or the spec's server dir, and throws if `<root>/mise.toml` does not exist in a
  source (non-release) backend.
- The same for central-core's entry, if it has a separate bin.
- Per backend rather than in the gateway: a worktree backend belongs to *its* checkout, not main. The gateway is Go
  and knows no repo layout. The backend already knows its root.
- Every child that inherits `process.env` (tmux clients through the `TMUX` shim path, `./equin`, `spawnCaptured`
  with `{...process.env}`) gets the pin. Children built from a closed list (`pickHostEnv`: `claude --print`, agent
  panes) do not. Agent panes run in their worktree, where the local walk applies. Decide per call site whether
  `pickHostEnv` should carry the pin. Recommendation: yes for `claude --print` (cwd `/tmp`), so add an optional
  `pin` argument rather than widening the host list.
- **Release**: no checkout exists, so there is no pin (`SINGULARITY_RELEASE` → skip). A release spawns no mise tool
  by name (compiled binaries throughout). Whether a release should prepend the shims at all is a separate question,
  noted below.

### 3. Enforcement: a check, because it rests on mise semantics we do not own
- Extend `toolchain:resolved` (`plugins/toolchain/check/index.ts`). In addition to today's probe, run each tool's
  `versionArgv` with **cwd = a fresh `mkdtemp` outside any checkout** and env = runtime PATH + `toolchainPin(root)`.
  Assert it reports the same locked version as the in-checkout probe. If mise ever changes how
  `MISE_GLOBAL_CONFIG_FILE` or lock lookup works, the build fails instead of backends drifting.

### 4. Docs
- Correct the fall-through wording wherever it survives. The shim falls through **only** to a non-mise copy later on
  PATH, and that copy is unlocked.
- `plugins/infra/plugins/launcher/CLAUDE.md` "What the runtime tree carries": add one paragraph with the rule.

## Out of scope (flag, not fix)
- **Releases prepend the shims too.** On a host with mise installed, a release's `TMUX` resolves to the shim and
  falls through or errors, with no checkout to pin to. Today no shipped composition includes `runtime-tmux`. If
  one ever does, a release should skip the shims and ship or require its own tmux. Worth an `add_task`.

## Verification
- `./equin test plugins/infra/plugins/launcher plugins/toolchain`, including new unit cases for `toolchainPin`.
- Manual: from `mkdtemp`, `env PATH=<runtimePath> MISE_GLOBAL_CONFIG_FILE=<wt>/mise.toml bun --version` gives the
  locked version. Without the variable you get the mise error (the baseline recorded above).
- `./equin build` (background), then from the deployed backend: confirm tmux sessions still spawn (open an agent
  conversation) and `./equin check toolchain:resolved` passes.
- Negative control: temporarily point the pin at a probe lock with an older go and confirm the new check fails.

## As implemented (deviations from the plan above)
- `toolchainPin()` lives in **`infra/paths/core`** (`internal/toolchain-pin.ts`), not `launcher/core`, and takes no
  argument: it pins `REPO_ROOT` and returns `{}` in a release, so the release decision is made once. `launcher/core` →
  server-core would close a plugin cycle (launcher's server barrel imports server-core).
- The serve-mode pin is a side-effect import `server-core/bin/pin-toolchain.ts` (right after `declare-namespace`), not
  `shared/boot-stages.ts`: server-core's non-`bin/` folders reaching `paths` closes the cycle
  server-core → paths → spawn → spawn-priority → server-core. `exec` processes inherit the pin from the backend that
  spawns them (the supervisor spawns with `{ ...process.env, … }`). Central pins at the top of `central-core/bin/index.ts`.
- `claude --print` (`pickHostEnv`, closed list, cwd `/tmp`) is left unpinned: it runs no mise tool.
