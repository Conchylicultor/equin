# Migrate legacy `console.log` call sites & retire the temporary allowlist

**Date:** 2026-06-08
**Category:** global (spans `debug/logs`, `database/migrations`, `framework/cli`, `framework/tooling/checks`, `primitives/avatar`)

## Context

The `debug-logs/no-console-log` ESLint rule now applies repo-wide (it previously
only covered the logs plugin's own subtree). To avoid breaking the build when the
rule went global, 13 pre-existing files were placed on a **temporary allowlist** —
the `ignores["no-console-log"]` array in
`plugins/debug/plugins/logs/lint/index.ts` (read generically by the root
`eslint.config.ts`). The goal of this task is to get every file off that allowlist
the *right* way and leave **zero individual file entries** behind — only
principled, permanent globs.

The core judgment call (flagged in the task) is **which files genuinely belong on
`console` vs. the structured `Log.channel()` logger**. Investigation surfaced two
load-bearing facts that decide it:

1. **`Log.channel()` only reaches the Logs pane / `read_logs` from inside a
   worktree server.** The `logs` plugin (which serves `/ws/logs` + persists JSONL)
   runs **only** on the per-worktree server — not on central, not in the CLI.
2. **Persistence is opt-in.** `Log.channel(id)` is in-memory only (live pane);
   only `Log.channel(id, { persist: true })` writes
   `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl` and is therefore
   `read_logs`-accessible. (Existing precedent like `orphan-sweep`'s
   `Log.channel("attachments")` is pane-only and invisible to `read_logs`.)

Consequences that shaped the design:

- **CLI `bin/` files** print to the developer's terminal — which *is* the
  agent-visible channel (the agent runs `./equin build` via Bash and reads
  stdout). Routing them through `Log` would **hide** their output. → permanent
  exemption.
- **`bin/` server/central entrypoints** (`server-core/bin`, `central-core/bin`)
  are boot bootstrap code whose stdout/stderr the gateway captures to
  `~/.singularity/logs/<name>.log`; console robustness matters most here.
  `central-core/` is also explicitly protected ("never modify unless instructed").
  → permanent exemption.
- **Central runtime** (`secrets/central/boot.ts`) is host-wide; its console is
  already captured to `~/.singularity/logs/central.log` (cat/tail-able). Making it
  `read_logs`-accessible would require giving the load-bearing `logs` plugin a new
  `central/` barrel and a new `secrets→logs` dependency edge that does not exist
  today — **not worth it** for one boot function. → permanent exemption.
- **Genuine worktree-server runtime code** (the migrations runner) *should*
  migrate, with `{ persist: true }`, so it surfaces in `read_logs` — and this adds
  **no new dependency** (the logs plugin already runs in that process).

## Approach

### A. Migrate the one worktree-server runtime file → structured logger (persisted)

`plugins/database/plugins/migrations/server/internal/runner.ts`

- Add `import { Log } from "@plugins/debug/plugins/logs/server";` and, at module
  scope, `const log = Log.channel("migrations", { persist: true });`
- Replace the drift `console.warn(...)` (line ~54) →
  `log.publish(\`[migrate] applied hash ${h} has no matching file on disk — DB may have drifted\`, "stderr");`
- Replace `console.log(\`[migrate] applying ${m.file}\`)` (line ~62) →
  `log.publish(\`[migrate] applying ${m.file}\`);`
- Boundary: `database/migrations/server` → `debug/logs/server` is a legal runtime-barrel
  import, no cycle (logs is fs+memory, no DB), and mirrors the existing
  `attachments/orphan-sweep.ts` precedent.

### B. Refactor the checks runner so its terminal output lives in the (exempt) CLI caller

`plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`

- Make `RunChecksOptions.log` **required** and `options` a required param:
  `runChecks(ids: string[] | undefined, options: RunChecksOptions)`.
- Remove the `?? ((line, stream) => stream === "stderr" ? console.error(line) : console.log(line))`
  default (lines ~108–109); use `const log = options.log;`.
- This removes the **only** `console.log` in the file. The `console.warn` (line ~34,
  in `loadAllChecks`) and `console.error` (line ~69) are **not** rule violations
  (the rule matches `console.log` only) and stay as-is — keeping load/validation
  failures loud even when no `log` callback is threaded yet.

`plugins/framework/plugins/cli/bin/commands/check.ts` (under `bin/`, exempt)

- Pass an explicit console logger to `runChecks`:
  `log: (line, stream) => stream === "stderr" ? console.error(line) : console.log(line)`.
- `build.ts` already passes a `log` callback (verified, ~line 797) — no change.

### C. Move the manual codegen script under `scripts/` (covered by the existing glob)

Move `plugins/primitives/plugins/avatar/server/internal/gen-icon-svg-map.ts`
→ `plugins/primitives/plugins/avatar/scripts/gen-icon-svg-map.ts`

- It is a `#!/usr/bin/env bun`, "run manually" generator; `console` is correct, and
  plugin-local `scripts/` dirs are established precedent (6 exist), covered by the
  `**/scripts/**` exemption and by `tsconfig.tools.json` (`plugins/**/scripts/*.ts`).
- Adjust the two path constants so inputs/outputs are unchanged:
  - `WEB_INTERNAL = resolve(HERE, "../web/internal")` (was `"../../web/internal"`)
  - `OUTPUT_PATH = resolve(HERE, "../server/internal/icon-svg-map.generated.ts")`
    — the generated file **stays** in `server/internal/` where `resolve-svg.ts`,
    `register-resolver.ts`, and `avatar/check/index.ts` import it (those reference
    the generated *output*, never the generator — safe to move the generator).
- Update the usage path in the file's docstring.

### D. Replace the 13 allowlist entries with principled permanent globs

`plugins/debug/plugins/logs/lint/index.ts` — rewrite `ignores["no-console-log"]` to:

```ts
ignores: {
  "no-console-log": [
    // scripts/ — standalone, run-manually processes where console *is* the logger.
    "**/scripts/**/*.{ts,tsx}",
    // bin/ — process entrypoints. CLI commands print to the developer's terminal
    // (the agent-visible channel); server/central daemons are boot bootstrap code
    // captured to ~/.singularity/logs/<name>.log. console is the right sink.
    "**/bin/**/*.{ts,tsx}",
    // central/ — the host-wide central runtime. The per-worktree logs plugin does
    // not run there; console is captured to ~/.singularity/logs/central.log.
    "**/central/**/*.{ts,tsx}",
  ],
},
```

Coverage check (all 13 former entries accounted for, **zero individual entries**):

| Former allowlist entry | Disposition |
|---|---|
| `database/.../migrations/.../runner.ts` | **Migrated** (A) → removed |
| `framework/.../tooling/.../checks/core/runner.ts` | **Refactored** (B) → removed |
| `primitives/.../avatar/.../gen-icon-svg-map.ts` | **Moved** to `scripts/` (C) → `**/scripts/**` |
| `framework/.../cli/bin/broadcasts.ts` | `**/bin/**` |
| `framework/.../cli/bin/commands/build.ts` | `**/bin/**` |
| `framework/.../cli/bin/commands/check.ts` | `**/bin/**` |
| `framework/.../cli/bin/commands/push.ts` | `**/bin/**` |
| `framework/.../cli/bin/commands/start.ts` | `**/bin/**` |
| `framework/.../cli/bin/git/register-merge-drivers.ts` | `**/bin/**` |
| `framework/.../cli/bin/migrations.ts` | `**/bin/**` |
| `framework/.../server-core/bin/index.ts` | `**/bin/**` |
| `framework/.../central-core/bin/index.ts` | `**/bin/**` (also `**/central/**`) |
| `infra/.../secrets/central/internal/boot.ts` | `**/central/**` |

> Note: `attachments/orphan-sweep.ts` from the task's original 14-file list was
> already migrated and is **not** in the current allowlist — nothing to do there.

## Critical files

- `plugins/debug/plugins/logs/lint/index.ts` — owns the allowlist (D)
- `plugins/debug/plugins/logs/server/internal/{log,registry,persist}.ts` — `Log` API (read-only ref; `{persist:true}` semantics)
- `plugins/database/plugins/migrations/server/internal/runner.ts` — (A)
- `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` — (B)
- `plugins/framework/plugins/cli/bin/commands/check.ts` — (B)
- `plugins/primitives/plugins/avatar/server/internal/gen-icon-svg-map.ts` → `.../avatar/scripts/gen-icon-svg-map.ts` — (C)

## Verification

1. `./equin build` — deploys; server boots and applies migrations. (Build
   runs `eslint` as a check; `no-console-log` must pass with the new globs and zero
   individual entries.)
2. `./equin check eslint` — green; confirms no remaining `console.log`
   violations and that the moved/refactored files are clean.
3. `git grep -n "console\.log" -- <each of the 13 paths>` — every hit is now either
   removed (migrated/refactored) or sits under a `bin/` / `central/` / `scripts/`
   path covered by a permanent glob.
4. **Migrations logger reaches `read_logs`:** the runner only logs when there are
   unapplied migrations or drift (a clean fork boots silent). To exercise it,
   inspect after a build that applies a migration, then
   `read_logs { channel: "migrations" }` (own worktree) shows the `[migrate] …`
   lines, and the JSONL exists at `~/.singularity/worktrees/<wt>/logs/migrations.jsonl`.
   (Caveat: silent on a no-op boot — that's expected.)
5. `./equin check` (direct) — check progress still prints to the terminal
   via `check.ts`'s console `log` callback; `./equin build` checks still
   stream into the build pane via its buffering `log`.
6. **Codegen script still works from its new home:**
   `bun run plugins/primitives/plugins/avatar/scripts/gen-icon-svg-map.ts` —
   regenerates `server/internal/icon-svg-map.generated.ts` (unchanged content/hash)
   and prints the "Generated …" line. Then `./equin check` (the avatar
   plugin's own `check`) confirms the generated file is in sync.
```
