# Step 6: `SINGULARITY_*` env vars → `EQUIN_*`, read under both names for a while

Track: the rename-to-equin track (wiki `block-dc049371-1f5f-413d-af7b-6e12b531d579`). Decision: [`2026-10-25-global-equin-internal-identifiers.md`](2026-10-25-global-equin-internal-identifiers.md), step 6.

## Context

About 60 `SINGULARITY_*` variables (646 mentions in about 206 tracked files outside `research/`) still carry the old name. They are a **cross-version contract**, crossed at four boundaries where the code on each side can be from a different version:

| Boundary | Older side | Newer side |
|---|---|---|
| installed plist / unit → gateway → backend | the plist's `-child-env` and env (written by an older `start`) | a worktree backend built today |
| main backend → `./equin build` / agent in a worktree | main (or a worktree not rebased yet) | either side |
| agent launcher → Claude Code → `.mcp.json`, `.claude/settings.json` hooks, `.githooks/*` | the checkout's files | the backend that launched it |
| operator's shell (`SINGULARITY_AUTH_*`, `SINGULARITY_CODESIGN_IDENTITY`, `SINGULARITY_DIR`, …) | the user's dotfiles | everything |

A plain rename breaks each of these. Most of the declaration already exists. `launcher/core/internal/runtime-env.ts` lists every name as **forwarded** or **withheld**, and `launcher:runtime-env-declared` makes sure no name is left out of that list. But the names are spelled in full everywhere, and they are read as raw `process.env.SINGULARITY_X` (157 sites), from string constants (`LANE_ENV = "SINGULARITY_LANE"`, about 20 of them) and by in-place mutation (`process.env.SINGULARITY_DIR ??= …`).

The outcome: one registry of **keys** (`DIR`, `CONVERSATION_ID`, …). Every read goes through `readEnv(key)`, which tries `EQUIN_<key>` and then `SINGULARITY_<key>`. Every writer sets both names. Go and the shell/JSON files that can't import the registry mirror it, and a check keeps them in sync. Once this lands, `product-name:legacy-id` no longer allows `SINGULARITY_*` anywhere outside the owner and its declared mirrors.

## Design

### 1. The registry: keys instead of full names (`plugins/infra/plugins/launcher/plugins/env-names`)

- `RUNTIME_FORWARDED_ENV`, `RUNTIME_WITHHELD_ENV` and `RUNTIME_FORWARDED_PREFIXES` are re-keyed by the **suffix** (`DIR`, `PG_PORT`, `AUTH_`, …). The reasons stay as written. `satisfies Record<\`SINGULARITY_${string}\`, …>` goes away.
- `type EnvKey = keyof FORWARDED | keyof WITHHELD | \`${keyof PREFIXES}${string}\``. A key that is not declared is a **tsc error**, so an undeclared variable can't be written at all. That makes half of the old check unnecessary. The retired `WORKTREE` simply has no key.
- The names have exactly two spellings, both derived:
  - `envName(key)` = `` `${PRODUCT_NAME.toUpperCase()}_${key}` ``
  - `legacyEnvName(key)` = `LEGACY_IDS.envPrefix + key`. `envPrefix: "SINGULARITY_"` is a new entry in `product-name/core/internal/legacy-ids.ts`, and its `LEGACY_ID_NOTES` lists the mirror files.
- Two variables were born under the new name: `EQUIN_APP_COMPONENT` (`login-services/core/internal/app-component.ts`) and `EQUIN_RELEASE_DIR` (`converge-script.ts`, `release/cli/run.ts`). They are declared too, flagged as having **no legacy spelling**, so the writers don't dual-write them. Heredoc markers that only look like variables (`EQUIN_CADDY_SITE`, `EQUIN_UNIT`, `SINGULARITY_INSTALL_SH`) are renamed to `*_EOF`.
- **As built:** the declaration and the helpers live in a new leaf sub-plugin, `infra/launcher/env-names` (`core/internal/env-keys.ts`, `core/internal/env.ts`), which imports only `product-name/core`. They first went into `launcher/core`, but `plugin-boundaries` flagged a cycle: launcher imports `paths`, and `paths` reads env vars. `launcher/core` keeps the PATH and `pickRuntimeEnv` logic and imports env-names. The low-level packages (`packages/flock`, `spawn-priority`, `signal-origin`, `runtime-profiler/core`, …) import env-names directly.

### 2. The API (exported from `infra/launcher/env-names/core`)

```ts
readEnv(key, env = globalThis.process?.env ?? {}): string | undefined
envEntries({ BUILD_ID: id, BUILD_DETACHED: "1" }): Record<string, string>  // both names, for spawn env objects
setEnv(key, value, env = process.env)        // in-process mutation, both names
setEnvDefault(key, value, env = process.env)  // the `??=` form: set both only if readEnv(key) is unset
unsetEnv(key, env)                            // deletes both (the bootstrap's DEPS_REEXEC / LOCKED_BUN_REEXEC strip)
envNames(key): readonly [string, string]      // [new, legacy], for allowlists and -child-env
```

**What a read returns:**
- only one name is set → that value;
- both are set and equal → that value;
- both are set and **differ** → **throw** (`EnvNameConflictError`, naming both values and the fix: "unset one").

A disagreement can't happen between two pieces of new code, because they always write both names. It means either an old-code writer overrode the legacy name under a new-code ancestor, or an operator set both names in their shell. In neither case can the reader tell which value is meant, so per the fail-loudly rule it refuses rather than guessing.

`pickRuntimeEnv` (the starter → gateway filter) **normalises**: a declared key the starter's shell sets only under the legacy name is emitted under both names. That way the plist's environment already carries `EQUIN_*` for an operator who still exports `SINGULARITY_AUTH_*`. `runtimeEnvNames()` (the `-child-env` value) lists both names of every forwarded key, and both prefixes (`EQUIN_AUTH_*`, `SINGULARITY_AUTH_*`). This changes the gateway's flags, so the gateway-drift health row reports installed plists as **Out of date**. That is the intended signal to run `./equin start --force`. Until then, the old plist forwards the legacy names and the new backends read them.

Test support: `withEnv({ KEY: value | undefined }, fn)` in `env-names/core/testing` sets or restores both names. It replaces the hand-rolled save/`delete process.env.SINGULARITY_DIR`/restore in about 10 test files.

### 3. The sweep (TS, about 190 files)

The same mechanical change at every site:
- `process.env.SINGULARITY_X` → `readEnv("X")`
- `{ ...process.env, SINGULARITY_X: v }` → `{ ...process.env, ...envEntries({ X: v }) }`
- `process.env.SINGULARITY_X ??= v` → `setEnvDefault("X", v)`
- `const LANE_ENV = "SINGULARITY_LANE"` constants are deleted; their users take the key
- names inside messages → `` `${envName("CONVERSATION_ID")}` ``

Representative files: `launcher/bin/launch.ts` (`??=` block), `launcher/bin/teardown.ts`, `build/machine/internal/run-build.ts`, `cli/plugins/build/cli/run.ts`, `conversations/plugins/agent-launch/server/internal/agent-session-env.ts` (its allowlist takes `envNames(...)`), `auth/plugins/{google,notion}/central/internal/descriptor.ts` (`env.get` takes `envName`/`legacyEnvName`, or the central env accessor gains a key-typed `readEnv`), `paths/core/internal/paths.ts`, `database/plugins/embedded/shared/internal/paths.ts`, `cli/plugins/op-runtime/cli/lane.ts`, `host-admission/core/internal/grant.ts`, `packages/plugins/flock/core/internal/lifeline.ts`, `release/server/internal/preview-manager.ts`, `cli/plugins/deploy/cli/internal/converge-script.ts` (its generated systemd `Environment=` and env-file lines are interpolated from `envEntries`), and the `tooling/checks` run-context and runner.

The checks that matched the old spelling are retargeted to the API:
- `paths` check (`paths/check/index.ts:919`): "no re-read of `SINGULARITY_DIR`" becomes "no `readEnv("DIR")` / `setEnv("DIR")` outside `paths/core` (and the launcher bins)".
- `e2e-harness/check/target-not-env-derived.ts`: bans `readEnv(` and any raw `process.env.(EQUIN|SINGULARITY)_` in `e2e/`.
- The lint rule `namespace-identity/lint/no-ambient-worktree-env.ts` is **deleted**. `readEnv("WORKTREE")` is now a type error, and a raw spelling of an undeclared name fails the check in §5, so the rule has nothing left to catch. `no-laundered-checkout-namespace` stays.
- `web-artifacts/core/internal/vite-builder.ts`: `__SINGULARITY_GRAPH__` / `__SINGULARITY_COMMIT__` become `` `${LEGACY_IDS.artifactGlobalPrefix}GRAPH__` ``, since they were only passing because of the `SINGULARITY_\w*` allowance that this step removes.

### 4. Mirrors (files that can't import the registry)

| File | Change |
|---|---|
| `gateway/env.go` | `readEnv(key)`: the Go twin with the same rule (new, then legacy, error on conflict). The prefixes are constants `envPrefix = "EQUIN_"` and `legacyEnvPrefix = "SINGULARITY_"`. |
| `gateway/main.go` | `os.Getenv("SINGULARITY_DIR")` / `SOCKETS_DIR` → `readEnv("DIR")` / `readEnv("SOCKETS_DIR")`; the flag help text says `EQUIN_SOCKETS_DIR`. |
| `.claude/settings.json` (generated by `guards/agent-policy`) | `${EQUIN_GUARDS_ROOT:-${SINGULARITY_GUARDS_ROOT:-$CLAUDE_PROJECT_DIR}}`, sh nested defaults; the change is made in the generator. |
| `.githooks/prepare-commit-msg`, `.githooks/post-rewrite` | Read `${EQUIN_X:-$SINGULARITY_X}`; post-rewrite sets both names for its recursion guard. |
| `.mcp.json` | **Stays on `SINGULARITY_PARENT_HOST` / `SINGULARITY_CONVERSATION_ID`** for the window. Claude Code's `${VAR:-default}` isn't documented to nest, and this file is read by agents launched from a backend that may still be older, which sets only the legacy names. Every launcher sets both, so the legacy names are always present. The drop step flips it. |
| `cli/plugins/doctor/doctor.sh` | `${EQUIN_CLAUDE_BIN:-${SINGULARITY_CLAUDE_BIN:-…}}`. |
| `tauri/src-tauri/src/lib.rs` | Sets **only** `EQUIN_*`: it launches the `launch.ts` from its own bundle, built at the same version, so no older reader is on the other side and no Rust read mirror is needed (the menu-bar Rust reads no variable). |
| `sidequests/claude-web/session-picker.sh` | Exports both names (its claude reads `.mcp.json`). |
| `sidequests/clean-install/*.sh` | `SINGULARITY_DIR_RESOLVED` is a shell local and gets renamed. The heredoc marker becomes `INSTALL_SH_EOF`. (`~/.singularity` stays; that is step 7.) |

The files that may still spell `SINGULARITY_` are listed as `envPrefix`'s `mirrors` in `LEGACY_ID_NOTES`, so `product-name:legacy-ids-in-sync` already checks that each one still spells it. That covers `gateway/env.go`, `.claude/settings.json`, `.githooks/*`, `.mcp.json`, `doctor.sh` and `session-picker.sh`.

### 5. Enforcement

`launcher:runtime-env-declared` becomes `launcher:env-names`, which has three rules (rule 2 skips test files, since a test of the filter spells undeclared names on purpose):
1. **No full name in TS code** outside the registry: a `(?<!\w)(EQUIN|SINGULARITY)_[A-Z0-9_]+` token in a TS file with comments stripped fails. Code reaches variables through `readEnv`, `envEntries` and the other helpers; comments and markdown may still say `EQUIN_X`.
2. **Every name a mirror or doc spells is declared**: any such token in a tracked non-TS file or a TS comment must name a declared key or prefix, so a doc can't keep a dead name or a typo. Research is out of scope.
3. **No stale key**: every declared key is used somewhere outside the declaration, either as a `"KEY"` argument or object key to a helper, or as a full name in a mirror. This is the old check's second half, carried over.

`product-name:legacy-id`: **delete the `SINGULARITY_\w*` ALLOWED line**. What remains spelled is the `envPrefix` owner value and its mirrors.

### 6. Docs

Every CLAUDE.md / docs mention outside `research/` says `EQUIN_X` (about 47 markdown files, plus the `package.json` descriptions of `serve-app` and `namespace-identity`). The launcher CLAUDE.md documents the window: both names are read, both are written, a conflict throws, `.mcp.json` lags behind, and the drop step comes later. Research docs are historical and stay as they are (that check excludes `research/` too).

## Not in this step

- Dropping the legacy names. That step is filed only after every install has restarted on the dual-read code (`start --force`) and the operator's dotfiles have moved. It flips `.mcp.json`, deletes `legacyEnvName` / `envPrefix`, and makes a conflict impossible.
- `~/.singularity` and the launchd label (step 7, the next main task).

## Verification

- `./equin test plugins/infra/plugins/launcher` — new unit tests of `readEnv` (new wins / legacy fallback / equal both / conflict throws), `envEntries`, `setEnvDefault`, `unsetEnv`, and `pickRuntimeEnv` normalisation; updated `runtime-env.test.ts` for the doubled `runtimeEnvNames()`. `go test ./gateway/...` for the Go `readEnv` and the updated `env_test.go`. Tests touched by the sweep: `./equin test plugins/framework/plugins/product-name plugins/framework/plugins/cli plugins/framework/plugins/tooling/plugins/checks`.
- `./equin check` — `launcher:env-names`, `product-name:legacy-id` with the allowance gone, `product-name:legacy-ids-in-sync`, `type-check`, `paths` and `e2e-harness`.
- **Cross-version, for real**: `./equin build` this worktree while the installed gateway still runs main's old binary and plist. The backend boots on `SINGULARITY_*` only, and `http://<worktree>.localhost:9000` serves (that is the old-gateway → new-backend boundary). Then launch an agent from this build and check that its environment has both names, and that `.mcp.json` resolves (MCP tools answer).
- The gateway-drift row on this build shows the gateway **Out of date** (the flags now differ): the intended signal. `start --force` is the user's to run after the push.

## On landing

Update the track page (status and the Step 6 checklist), and file Step 7 as the next main task, giving the track page id. The drop-legacy step is **not** filed yet.
