# Retire `SINGULARITY_WORKTREE` as an inherited env var: a runtime declares its namespace once, at its entry point

## Context

The conversation "Op profiling" pane showed *No build, push, or check activity*
for a conversation that had run a test and several builds. The records were in
the op log, but every one was stamped `worktree: "singularity"`, and the
profiling reader keys a record on that field before its checkout slug.

The value came from the environment. `SINGULARITY_WORKTREE` answers "which
namespace is this **runtime** the server for": the gateway sets it on every
backend it spawns (`gateway/worktree.go`). But an env var reaches every
descendant forever. The main backend was the first process to talk to the tmux
server after a restart (Sept 6, and again after the Sept 10 kernel panic), so
the tmux server kept main's environment, and from then on every agent session
started from `SINGULARITY_WORKTREE=singularity`. Every `./equin build`,
`check`, `test` an agent ran inherited it. Nothing chose that value; the
sessions picked up a variable nobody meant them to have.

Two identities were conflated:

- **Runtime namespace** — a backend / exec child's namespace. Only its spawner
  knows it (a composition backend runs out of main's checkout). Today:
  `currentWorktreeName()` / `isMain()` in `plugins/infra/plugins/paths/core`.
- **Checkout name** — the checkout a CLI acts on, derived from its git root.
  Today: `checkoutWorktreeName(root)` / `checkoutNamespace(root)`, same plugin.
  The paths plugin already documents that a CLI must never use the env answer.

The e2e harness hit this exact leak before (`e2e-harness/check/target-not-env-derived.ts`,
`e2e/target.ts`) and fixed it locally. This plan fixes the class: the variable
stops existing as ambient state, so the wrong reading has no spelling.

Outcome: a process either declared its runtime namespace at its entry point, or
asking for one throws. Agent shells start from an allowlisted environment. The
op log has one identity field. The conversation pane and the Debug → Profiling
Gantt attribute every agent op to its own worktree again.

Out of scope (filed separately): making both op surfaces update live (today
both are one-shot fetches; pattern to reuse is `op-status`'s file watcher →
push resource, `plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/watcher.ts`).

## Design

### A. `infra/runtime-identity/core` — the one home for a process's namespace

New leaf plugin, `plugins/infra/plugins/runtime-identity/core`, importing only
`@plugins/infra/plugins/namespace/core`.

```ts
declareRuntimeNamespace(ns: Namespace): void   // once; a different redeclare throws
runtimeNamespace(): Namespace                  // throws if undeclared
isMain(): boolean                              // runtimeNamespace() === MAIN_WORKTREE_NAME
```

The throw message states the rule: *this process has not declared a runtime
namespace; backends receive it as `--namespace` from the gateway, exec children
from their spawner; a CLI acting on a checkout uses `checkoutNamespace(root)`.*

`MAIN_WORKTREE_NAME` moves from `paths/core` to `namespace/core` (it is derived
purely from `namespaceFor(MAIN_COMPOSITION_ID, { kind: "main" })`, namespace
data, not a path). Importers switch to the namespace barrel; no re-export.

`currentWorktreeName()` and `isMain()` are **removed** from `paths/core`. The
name "current worktree" is the ambiguity that caused the bug; the concept is
renamed at every call site (~95 backend sites, mechanical) to
`runtimeNamespace()`. `paths/core` keeps `checkoutWorktreeName` /
`checkoutNamespace` — the CLI's identity.

Test hook: `resetRuntimeNamespaceForTest()` exported from the same barrel,
used only by `test/bun-preload.ts` and the one suite that simulates several
worktrees (`log-channels/server/internal/handle-emit.test.ts`).

### B. Transport is argv, never env

- **Gateway → backend.** `gateway/worktree.go` `startBackend` appends
  `"--namespace", w.Name` to argv (after the `taskpolicy -b --` wrapping, for
  both the `spec.Command` release form and the `bun bin/index.ts` dev form) and
  **stops setting** `SINGULARITY_WORKTREE` in `cmd.Env`. `startZeroCache` drops
  its `SINGULARITY_WORKTREE` line too: the zero-cache start script reads only
  `ZERO_*` (verified: `database/plugins/zero/plugins/cache-service/scripts/start.ts`).
- **Backend entry.** New `plugins/framework/plugins/server-core/bin/declare-namespace.ts`,
  imported as the **first** statement of `bin/index.ts` (before the
  `server-core/core` barrel, so it evaluates before `./active-runtime` →
  `plugins-active.ts`, whose top level selects the registry, and before
  `config_v2/server/internal/config-dir.ts`, which throws at module eval).
  It parses `--namespace <ns>` from `process.argv` and declares it.
  `plugins-active.ts` reads `runtimeNamespace()` instead of the env.
- **Gateway-restart transition** (the Go daemon is not rebuilt on push; the
  user restarts it by hand with `./equin start`). Until then the running
  gateway still sets env and no argv. `declare-namespace.ts` therefore carries
  the **only** allowed env read in the tree: if no `--namespace` argv is present
  and the env var is, declare from it and log one warning naming the fix
  (*restart the gateway to pick up the argv contract*). Marked with the lint
  rule's single allowlist entry. Follow-up (own task, after the restart):
  delete the fallback.
- **Exec children.** `runExec(namespace, body)` takes the namespace as a
  parameter and declares it first (replacing `assertWorktreeIdentity`, same
  position, before the dynamic `import("../bin/active-runtime")`). The
  `supervised-exec` command gains a required `--namespace <ns>` option
  (per-command option, the CLI's established idiom in
  `cli/bin/register-commands.ts`). Its argv producer,
  `jobs/plugins/supervised-task/server/internal/registry.ts` `invoke()`,
  appends `"--namespace", runtimeNamespace()`.
- **Deploy legs.** `apps/plugins/deploy/plugins/deployments/server/internal/run-deploy.ts`
  `deployArgv` documents relying on inheritance. The child (`deploy` CLI,
  `cli/internal/target.ts`, `closure-guards.ts`) switches to
  `checkoutNamespace(root)` — it acts on the checkout it runs from, which is
  the backend's own checkout. The doc comment is rewritten; no argv needed.
- **`apply-migrations`** gains `--namespace <ns>`, defaulting to
  `checkoutNamespace(root)`. `mise.toml:64` drops its env prefix (main checkout
  resolves to `singularity` by itself). Its docstrings and
  `server-core/scripts/backfill-pushes.ts` follow the same shape.
- **`release/cli/run.ts:1127`** (`pruneReleaseRunDirs(currentWorktreeName(), …)`)
  switches to `checkoutWorktreeName(root)`, matching line 855 of the same file.
  These three CLI sites are live bugs today (they answer `singularity` from
  every worktree); with the throw they would crash, so they are fixed first.
- **Other explicit setters** switch to passing the checkout name as they
  already compute it, or are deleted:
  - `cli/plugins/migrations/cli/migrations.ts:353`,
    `database/plugins/migrations/check/internal/schema-files-loadable.ts:43`,
    `checks/plugins/migrations-in-sync/check/index.ts:85` spawn drizzle-kit /
    a require probe with `SINGULARITY_WORKTREE: basename(root)`. Those children
    import schema files that no longer read env at import, so the key is
    removed; if a child still needs a namespace it receives `--namespace`.
  - `plugin-meta/plugins/barrel-import/core/internal/stubs.ts` calls
    `declareRuntimeNamespace(asNamespace(BARREL_STUB_WORKTREE))` instead of
    `process.env ??=` (both lines, the second is dead today). The value-scoped
    scrub in `cli/plugins/op-runtime/cli/check-subprocess.ts:158` is deleted:
    module state cannot be inherited.
  - `test/bun-preload.ts` declares `checkoutWorktreeName(REPO_ROOT)`.
- **Ambient `{ ...process.env }` spawns** (`supervised-run/server/internal/supervisor.ts:568`,
  `check-subprocess.ts:148`) need no change: once no backend has the variable,
  there is nothing to inherit.

### C. Readers move to the identity module

Every `process.env.SINGULARITY_WORKTREE` read is replaced:

| site | becomes |
|---|---|
| `database/server/internal/client.ts` `requireWorktree()`, `database/plugins/admin/server/internal/pool.ts` | `runtimeNamespace()` (throw semantics preserved, message improves) |
| `config_v2/server/internal/config-dir.ts` (module eval) | `runtimeNamespace()` |
| `log-channels/server/internal/persist.ts` `logsDir()` | `runtimeNamespace()` |
| `reports/server/internal/{record-report,buffer}.ts`, `slow-ops/.../record-slow-op.ts`, `boot-profile/.../handlers.ts`, `jobs/server/internal/forfeit.ts` | `runtimeNamespace()` (backend only; the `?? "unknown"` fallbacks go, they were absorbing failure) |
| `conversations/server/internal/lifecycle.ts:107`, `runtime-tmux/.../tmux-runtime.ts:603` (`SINGULARITY_PARENT_HOST`) | `runtimeNamespace()` |
| `debug/.../op-log/server/internal/profiler.ts:112` | deleted (see D) |

### D. Op log: one identity field

- Delete `worktree` from `RawOpRecord`, `OpRecord` (`op-log/core/internal/types.ts`),
  `identityOf` in `fold.ts`, the writer's `identity()` in `profiler.ts`, the
  `fold.test.ts` fixture, and `OpDetailSchema` in `ops/shared/endpoints.ts`.
- `ops/server/internal/handle-op-profiling.ts`: `worktreeOf(r)` becomes
  `r.opSlug ?? canonicalWorktree(r.branch)`. Every current writer passes a
  non-null slug from `checkoutNamespace(root)`; the branch fallback only serves
  foreign or pre-July lines. `matchesWorktree` and the two comments about
  "pushes fall back to the branch when SINGULARITY_WORKTREE is unset"
  (`handle-op-profiling.ts:22`, `op-gantt.tsx:317`) are rewritten for the slug.
- No backfill: records since July carry `opSlug`.
- Empty state in `push-profiling-pane.tsx` and the plugin description name
  three kinds; derive the wording from `OP_KINDS` labels
  (`@plugins/infra/plugins/worktree/core`, web-safe) so test/e2e are covered.

### E. Agent sessions start from an allowlisted environment

`runtime-tmux/server/internal/tmux-runtime.ts` `create()`: the exec'd process
stays `zsh -l -c "<wrapper>"` (tmux execs it directly, so that zsh is the only
place `$VAR` expansion can happen, and it sees tmux's injected `TMUX` /
`TMUX_PANE` plus the two `-e` values). The wrapper is
`exec env -i <ALLOWLIST as NAME="$NAME"…> zsh -l -c '<claudeCmd>'`, with
`backgroundPrefix()` in front as today. The allowlist is one exported constant
in the plugin (`agentSessionEnvAllowlist`): `HOME USER LOGNAME SHELL TERM LANG
LC_* TMUX TMUX_PANE SINGULARITY_CONVERSATION_ID SINGULARITY_PARENT_HOST` plus a
`PATH` seed of `/usr/bin:/bin:/usr/sbin:/sbin` (the inner login shell rebuilds
PATH from the user's profile; the seed keeps early rc lines that shell out from
failing). `TMUX_PANE` must survive: tier-1 pane ownership in this plugin's
CLAUDE.md is keyed on it.

Why allowlist, not `tmux set-environment -g -u`: the set of variables a
backend's ambient environment may carry is open; naming the bad ones is a
denylist that only ever catches the last leak found. The allowlist makes the
tmux server's environment irrelevant by construction.

### F. Enforcement

- **Type:** `runtimeNamespace()` returns the branded `Namespace`; the CLI side
  keeps returning plain `string` from `checkoutWorktreeName` (the existing
  `no-laundered-checkout-namespace` rule already bans casting across).
- **Lint (rung 3):** new rule in
  `tooling/plugins/lint/plugins/namespace-identity/lint/`, beside the existing
  one: the identifier `SINGULARITY_WORKTREE` may not appear in code anywhere but
  `server-core/bin/declare-namespace.ts` (the transition fallback). Docs and
  research prose are not linted.
- **Runtime (rung 4):** undeclared `runtimeNamespace()` throws.
- **Docs:** `paths/CLAUDE.md`, `server-core/CLAUDE.md`, `runtime-tmux/CLAUDE.md`,
  `supervised-task/CLAUDE.md` ("nothing is plumbed" paragraph),
  `op-log/CLAUDE.md`, `gateway/CLAUDE.md` describe the argv contract and the
  two identities.

## Steps (each builds and checks green on its own)

1. **Identity module, behaviour-preserving.** Create `infra/runtime-identity/core`;
   move `MAIN_WORKTREE_NAME` to `namespace/core`. For this step only,
   `runtimeNamespace()` falls back to the env var, so nothing changes yet.
   Rename all `currentWorktreeName` → `runtimeNamespace` and move `isMain`
   importers (scoped by import path: `auth/web` has an unrelated function of
   the same name). Delete both from `paths/core`.
2. **Fix the three CLI misuses** (deploy `target.ts` + `closure-guards.ts`,
   release `run.ts:1127`) to checkout identity. Rewrite `run-deploy.ts`'s
   comment.
3. **Argv transport.** `declare-namespace.ts` first in `bin/index.ts`;
   `plugins-active.ts` reads the module; gateway appends `--namespace` and
   drops both env lines; `runExec(namespace, body)`; `supervised-exec
   --namespace` (declaration + `registry.ts` producer); `apply-migrations
   --namespace`; `mise.toml`.
4. **Setters and stubs.** barrel-import declares; check-subprocess scrub
   deleted; the three drizzle-kit / probe spawns drop the env key;
   `bun-preload.ts` and `handle-emit.test.ts` use the module.
5. **Readers** (section C) move to `runtimeNamespace()`.
6. **Flip the throw**: remove the step-1 fallback from `runtimeNamespace()`;
   the only env read left is the gateway-transition branch in
   `declare-namespace.ts`.
7. **Op log** (section D).
8. **tmux allowlist** (section E).
9. **Lint rule + docs** (section F). Regenerate plugin docs via the build.

## Verification

- `./equin build` (background) green, then `./equin check`.
- Unit: `./equin test plugins/debug/plugins/profiling/plugins/op-log`,
  `plugins/framework/plugins/tooling/plugins/lint/plugins/namespace-identity`,
  `plugins/primitives/plugins/log-channels`, `plugins/framework/plugins/server-core`.
- Boot log of this worktree's backend (`~/.singularity/worktrees/<wt>/logs/`)
  shows the transition warning (old gateway still running) and no other
  `SINGULARITY_WORKTREE` mention; `ps` shows `--namespace <wt>` once the user
  restarts the gateway.
- In a fresh agent session on this branch: `env | grep -E 'SINGULARITY|SOCKET_PATH|^PG'`
  prints only `SINGULARITY_CONVERSATION_ID` and `SINGULARITY_PARENT_HOST`;
  `echo $TMUX_PANE` is set; `claude` boots and its MCP tools answer
  (`query_db` from that session).
- Run `./equin check` from this worktree, then query the op-log line:
  `tail -1 ~/.singularity/logs/op-log/op-log.jsonl` has `opSlug` = this
  attempt id and no `worktree` key.
- Open the conversation's Op profiling pane (`/agents/c/<conv>/pp`) via
  `screenshot.ts`: the Gantt shows this worktree's row. Debug → Profiling shows
  one row per worktree, none named `singularity` except main's own ops.
- Supervised task end-to-end: trigger a backup run from the UI; the child
  boots (`supervised-exec … --namespace <ns>` visible in `ps`) and completes.
- Regression guard: a hand-run `SINGULARITY_WORKTREE=singularity ./equin check`
  from a worktree records `opSlug` = the worktree, not main.

## Follow-ups (own tasks)

- ~~Delete the gateway-transition env fallback in `declare-namespace.ts` after
  the user has restarted the gateway; drop the lint allowlist entry.~~ Done
  2026-09-15: gateway restarted with `./equin start --force`, fallback and
  allowlist entry removed. The restart surfaced that the gateway daemon forwards
  its starter's whole environment to every backend; filed as its own task.
- Live refresh of both op surfaces (file watcher on `op-log.jsonl` → push
  resource), per the monitoring page.
- `SOCKET_PATH` is the remaining gateway-set env var; it is derivable from the
  namespace and could move to argv the same way.
