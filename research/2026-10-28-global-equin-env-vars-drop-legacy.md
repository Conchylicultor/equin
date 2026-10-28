# Drop the legacy `SINGULARITY_*` env var names

Track: rename-to-equin (wiki `block-dc049371-1f5f-413d-af7b-6e12b531d579`). Follows step 6
([`2026-10-25-global-equin-env-vars.md`](2026-10-25-global-equin-env-vars.md)), which opened a
dual-name window: every read tries `EQUIN_<key>` then `SINGULARITY_<key>`, every write sets both.

## Context

The window was there for processes on older code: installed plists, older gateways, older
checkouts, and operators' dotfiles. The goal now is that only `EQUIN_*` remains and the old prefix
is rejected everywhere.

### State of this machine (checked 2026-10-28)

| Reader / writer | State | Safe to drop? |
|---|---|---|
| Installed `dev.equin.gateway.plist` | `-child-env` lists both names for every key, so it was written by step-6+ code (`start --force` ran). Its `EnvironmentVariables` holds no app variable except `EQUIN_APP_COMPONENT`. | yes |
| Data dir | `~/.equin` is live, and `~/.singularity` is a **symlink** to it. Step 7 has run. | yes (env-wise) |
| Shell dotfiles (`~/.zsh*`, `~/.profile`, `~/.bashrc`), `launchctl getenv` | no `SINGULARITY_*` (only in shell history) | yes |
| Other LaunchAgents (menu-bar, sidequest plists) | no `SINGULARITY_*` | yes |
| Tauri app | already sets only `EQUIN_*` | yes |
| Remote deploys (`converge-script.ts`) | regenerate the unit and env file with the release they install (same version) | yes |
| **Worktrees branched before step 6** (`f4c6050558`) | 151 of 219. **19 of them have `waiting` conversations** (latest activity 2026-10-27). | **no**, see below |

A pre-step-6 worktree reads only the legacy names: its `.mcp.json` (`SINGULARITY_PARENT_HOST` /
`SINGULARITY_CONVERSATION_ID`), its hooks, and its CLI. Once main's launcher writes only `EQUIN_*`,
resuming one of those 19 conversations starts an agent with no MCP tools (the URL resolves to
`http://.localhost:9000/…`), and that worktree's own `./equin build` is missing its conversation and
lane variables. The fix is the usual one, rebasing onto main (`git rebase origin/main`), which
brings the new `.mcp.json` and code. **Decision for the user**: accept this (recommended), or wait
until those worktrees are finished or archived.

## Design

The key-based API stays. It is still what makes an undeclared variable a tsc error and keeps full
names out of TS code. What changes is that each key now has **one** name.

### 1. `infra/launcher/env-names` (one name per key)

- `env-keys.ts`: delete `LEGACY_ENV_PREFIX`, `NEW_NAME_ONLY` and `envNames`. `envKeyOf` checks only
  `ENV_PREFIX`. `isDeclaredEnvName` loses its new-name-only branch. The header comment explains one
  name per key.
- `env.ts`: delete `EnvNameConflictError`. `readEnv` = `env[envName(key)]`. `envEntries`, `setEnv`
  and `unsetEnv` write one name. `setEnvDefault` keeps its contract (it returns the resolved value).
- `core/index.ts`: drop `envNames` and `EnvNameConflictError` from the barrel. Update
  `testing/with-env.ts`.
- Callers of `envNames(...)` switch to `envName(...)`:
  - `agent-session-env.ts` (its allowlist)
  - `converge-script.ts` (lines 51 and 491)
  - `e2e-tool-use-id.ts`
  - `agent-policy.ts` (`ROOT` becomes the single `${EQUIN_GUARDS_ROOT:-$CLAUDE_PROJECT_DIR}`)
  - `runtime-env.ts`: `pickRuntimeEnv` no longer normalises; `runtimeEnvNames()` lists one name per key and one prefix
  - the tests that iterate the names: `runtime-env.test`, `agent-session-env.test`, `reexec.test`,
    `doctor.test`, `listen.test`, `children-die-with-parent.test`, `env.test`, `env-keys.test`

### 2. Mirrors (they flip to the new names only)

- `gateway/env.go`: `readEnv(key) string` = `os.Getenv(envPrefix+key)`. Delete `legacyEnvPrefix` and
  `mustReadEnv`. `main.go` calls `readEnv`. Update `env_test.go`.
- `.mcp.json`: `${EQUIN_PARENT_HOST}` / `${EQUIN_CONVERSATION_ID}`.
- `.claude/settings.json`: regenerated from `agent-policy` (no hand edit).
- `.githooks/prepare-commit-msg`, `.githooks/post-rewrite`: `$EQUIN_X` only.
- `doctor.sh`: `${EQUIN_CLAUDE_BIN:-…}`.
- `sidequests/claude-web/session-picker.sh`: export `EQUIN_*` only.

### 3. Enforcement (the old prefix is gone everywhere)

- `product-name/core/internal/legacy-ids.ts`: delete `envPrefix` and its `LEGACY_ID_NOTES` entry.
  With no owner value and no mirrors left, `product-name:legacy-id` (`OLD_NAME = /singularity/i`)
  rejects `SINGULARITY_` in every tracked file outside `research/`, with no new rule needed.
- `launcher/check/index.ts` (`launcher:env-names`): drop the legacy alternative from the token regex
  (line 69) and the grep loop (line 103). Rule 2 then reads "every `EQUIN_*` a doc or mirror spells
  is declared".
- `agent-session-env.test.ts`'s `LEAKED_NAMESPACE_VAR`: build it from `ENV_PREFIX` (the retired
  `WORKTREE` key under the current prefix) instead of `LEGACY_IDS.envPrefix`.

### 4. Docs

The launcher, env-names, product-name, agent-policy, gateway, paths and `root-migration` CLAUDE.md
files describe one name per key, with no window. `docs/plugins-details.md` is regenerated by the
build.

### Side effect, expected

`runtimeEnvNames()` changes, so the health report's Gateway row shows **Out of date** until
`./equin start --force`. Nothing breaks in the meantime: the installed plist already forwards the
`EQUIN_*` names.

### Not in scope

- The `~/.singularity → .equin` symlink on disk. Step 7's v2 meant to remove the old folder; it
  exists here as a symlink. Flag it to the user; don't touch it.
- Step 8 (renaming the GitHub repo) is the next main task.

## Verification

- `./equin test plugins/infra/plugins/launcher plugins/conversations/plugins/agent-launch plugins/framework/plugins/cli plugins/framework/plugins/tooling/plugins/guards plugins/infra/plugins/spawn plugins/framework/plugins/product-name`
- `go test ./gateway/...`
- `./equin check`: `launcher:env-names`, `product-name:legacy-id`, `product-name:legacy-ids-in-sync`,
  `type-check`, `agent-policy` in sync.
- `git grep -n SINGULARITY_ -- ':!research'` is empty.
- `./equin build`, then launch an agent on this build and confirm its env holds only `EQUIN_*`, its MCP
  tools answer (`.mcp.json` resolves), and its guard hooks run.

## On landing

Update the track page: status, tick "Drop the old variable names", and note the symlink. File
Step 8 (rename the GitHub repo) as the next main task, with the track page id.
