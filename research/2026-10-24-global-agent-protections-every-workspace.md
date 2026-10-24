# Agent protections in every workspace

## Context

Scratch-workspace agents (Sonata transcription, Places ask) run with **no PreToolUse guards and no
stop guard**. The guards are registered only in the repo's `.claude/settings.json`
(`bun "$CLAUDE_PROJECT_DIR/…/guards/bin/guard.ts"`), which Claude Code loads only when the cwd is
inside the repo. A scratch dir (`state/workspaces/<attemptId>`) is not, and its launch
(`workspace/plugins/scratch/server/internal/launch-fragment.ts`) uses `settingSources: ["user",
"project"]`, where "project" means the scratch dir. The design doc
(`research/2026-10-13-global-agent-workspaces-and-sonata-transcription.md:16`) dropped the guards on
purpose, filing them under "the app's own context". These agents run under `bypassPermissions` with
Bash/Write/Edit allowed, so nothing stops a write into the main checkout, an unbounded `find`, psql
against the cluster, a sleep loop, or a subagent walking away from its op.

The root cause is that **repo context** (CLAUDE.md, skills, MCP config) and **protections** (hooks,
deny rules) share one file, and that file only reaches agents whose cwd is in the repo.

Outcome: protections are declared once in code and carried by every app launch, whatever the
workspace kind. A protection added later reaches every agent with no further wiring. Sessions a
human starts in the repo keep working from a generated `.claude/settings.json`.

Audit result (previous turn): no guard needs a per-workspace exclusion. Each one either guards a
hazard reachable from any cwd, or matches only commands a scratch agent never runs. So there is
**no `appliesTo` field**. Two guards do need a fact they currently guess: `main-edits`/`main-writes`
(the workspace root) and `bun-script` (whether the script is in a checkout).

Decision (user, 2026-10-24): **a worktree agent runs its own checkout's guards**, so it can edit and
test them. A scratch agent runs the launching backend's checkout's guards.

## Design

### 1. One declaration of the agent policy — `guards/core/agent-policy.ts`

```ts
export const AGENT_POLICY_GUARDS_ROOT_ENV = "SINGULARITY_GUARDS_ROOT";
export const AGENT_POLICY_WORKSPACE_ROOT_ENV = "SINGULARITY_WORKSPACE_ROOT";

/** Every protection an agent runs with: hooks + deny rules. */
export function agentPolicySettings(): { hooks: LaunchHooks; permissions: { deny: string[] } }
```

- Hooks: PreToolUse (`Bash|Write|Edit|Read|NotebookEdit|Agent` → `bin/guard.ts`), SubagentStop
  and TeammateIdle (→ `bin/stop-guard.ts`), including today's "bun not on PATH" exit-2 prefix.
  Deny: `EnterWorktree`, `ExitWorktree`.
- **One command string, spelled the same everywhere:**
  `bun "${SINGULARITY_GUARDS_ROOT:-$CLAUDE_PROJECT_DIR}/plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts"`.
  - Human session in the repo: the env var is unset, so the guards come from the project dir (as
    today).
  - App launch: the env var names the workspace's guards root.
  - In a worktree, the project file and the launch both register the same string. Claude Code
    deduplicates identical hook commands, so the guards run once. (**Verify** this. If it does not
    hold, fall back to the project rendering short-circuiting on
    `[ -n "$SINGULARITY_GUARDS_ROOT" ] ||`; see Verification.)
- The script paths are spelled relative to a checkout root (a `GUARD_SCRIPTS` constant), so the
  declaration never holds an absolute path and the generated file stays checkout-independent.

### 2. `.claude/settings.json` protection keys are generated, with an in-sync check

- Codegen step `claudeSettings` in `codegen/core/regen-pipeline.ts` (beside the other
  repo-tree artifacts, so build and push-normalize regenerate the same set). It rewrites `hooks` and
  `permissions.deny` in place from `agentPolicySettings()` and preserves every other key (repo
  context: `allow`, `env`, `skillOverrides`, …). Formatted via `formatGenerated`.
- Check `guards:claude-settings-in-sync` (`guards/check/index.ts`, same shape as
  `space-ramp-in-sync`): those keys must equal the declaration. A hook or deny rule added by hand
  then fails the check, and the hint names `agent-policy.ts`. This is how "added later" stays
  covered.

### 3. Every launch carries the policy — `agent-launch`

- `agentLaunchHooks()` → `agentLaunchPolicy()` in
  `conversations/plugins/agent-launch/server/internal/launch-settings.ts`. It returns compaction's
  `SessionStart` entry merged with the policy's hooks, plus the policy's deny rules. It is the only
  hooks source `runtime-sdk` reads (`machine/internal/sdk-runtime.ts:330`,
  `server/internal/launch-options.ts`), so no launch path can omit it.
- **Permissions become a typed field of `LaunchFragment`** (`workspace/server/internal/registry.ts`):
  `permissions?: { allow?; deny? }`. Scratch moves its profile's permissions from `settings` to that
  field. `sdkLaunchOptions` unions policy ∪ fragment into the one `permissions` key, which today would
  collide in `mergeLaunchSettings` and throw.
- **`LaunchFragment.guardsRoot: string` (required)**: the checkout whose guards this workspace runs.
  Making it required means tsc forces any new workspace kind to answer.
  - worktree → its own checkout path (the user's decision).
  - scratch → the backend's `REPO_ROOT` (`infra/paths/core`). It asserts the guard scripts exist
    there, like `compactionHookEntry` asserts its script, so a launch never installs a hook that
    cannot run.

### 4. The launch delivers the two roots as env

`AGENT_SESSION_DELIVERED_ENV` (`agent-launch/server/internal/agent-session-env.ts`) gains
`SINGULARITY_GUARDS_ROOT` and `SINGULARITY_WORKSPACE_ROOT`. Its type is keyed by that list, so a
missing value is a type error. `agentSessionEnv(id, { workspaceRoot: cwd, guardsRoot })` is called
from `runtime-sdk/machine/internal/agent-process.ts:161`. Both values ride `AgentLaunchOptions`
(already persisted per agent), so a relaunch or rewind keeps them.

### 5. Guards read the workspace root instead of guessing it

- `HookOptions` (`guards/core/runner.ts`) gains a required `workspaceRoot: string | null`, following
  the same "required, never defaulted" rule as `writableDataDirs`. `bin/guard.ts` reads it from
  `SINGULARITY_WORKSPACE_ROOT`, and it is exposed as `GuardContext.workspaceRoot`.
- `main-edits` / `main-writes` use the allowed root
  `ctx.workspaceRoot ?? worktreeContextOf(ctx.cwd)?.worktreeRoot ?? ctx.cwd`. Only a human session
  keeps the marker guess. Hint text is unchanged for worktrees; for a non-worktree root it says
  "your workspace".

### 6. `bun-script`: block only inside a equin checkout

The hazard is a module walking up into a checkout's `node_modules`. The guard now blocks only when
`classifyRepo(dirname(resolve(cwd, script)))` (`guards/core/git-target.ts`) is `singularity`. A
scratch dir's own scripts pass, so the `./equin run` hint is only ever shown where `./equin` exists.

### 7. Docs

- Correct the 2026-10-13 design doc's "context vs. guards" line.
- `workspace/scratch/CLAUDE.md` (launch section): scratch agents carry the policy.
- `guards/CLAUDE.md`: a short "where guards are registered" section covering the declaration, the
  generated file and the launch.

## Critical files

- `plugins/framework/plugins/tooling/plugins/guards/core/agent-policy.ts` (new), `core/index.ts`,
  `core/runner.ts`, `core/types.ts`, `core/context.ts`, `bin/guard.ts`, `core/guards/{main-edits,main-writes,bun-script}.ts`,
  `check/index.ts` (new)
- `plugins/framework/plugins/tooling/plugins/codegen/core/regen-pipeline.ts` (+ a `claude-settings-gen.ts`)
- `plugins/conversations/plugins/agent-launch/server/internal/{launch-settings,agent-session-env}.ts`
- `plugins/conversations/plugins/workspace/server/internal/registry.ts` (`LaunchFragment`)
- `plugins/conversations/plugins/workspace/plugins/{scratch,worktree}/server/internal/*` (fragments)
- `plugins/conversations/plugins/runtime-sdk/{server/internal/launch-options.ts,machine/internal/sdk-runtime.ts,machine/internal/agent-process.ts,core/protocol.ts}`
- `.claude/settings.json` (regenerated)

## Verification

- Unit tests (`./equin test` on guards, agent-launch, runtime-sdk, workspace/scratch):
  - the policy rendering;
  - `sdkLaunchOptions` permissions union, and that no duplicate-key throw remains;
  - `main-edits` / `main-writes` with a `workspaceRoot` outside any worktree (a scratch dir and its
    subdir allowed, the main checkout denied);
  - `bun-script` allowing a script outside a checkout and still denying one inside;
  - `agentSessionEnv` delivering both roots.
- `./equin check guards:claude-settings-in-sync` passes after build. Hand-adding a hook to
  `.claude/settings.json` makes it fail.
- **Dedupe**: in a worktree, run `claude -p` with the launch's `--settings` plus the project
  settings, and point the guard at a counter (or a temporary log line). Confirm one run per tool
  call. If it runs twice, switch the project rendering to the short-circuit form.
- **End to end**: `./equin build`, then launch a scratch conversation (Places ask) on this build. Ask
  it to run `find / -name x` and to write a file in the main checkout. Both are blocked, and the
  transcript shows the `PreToolUse` refusals. A worktree conversation's guard still loads from its
  own checkout: edit a guard's message in the worktree and see it change.
