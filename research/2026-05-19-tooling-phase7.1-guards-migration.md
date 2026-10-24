# Phase 7.1: Guards → `tooling/plugins/guards/`

Sub-task of [Phase 7 tooling migration](./2026-05-19-phase7-tooling-to-plugin.md).

## Context

Guards are the Claude Code PreToolUse hook system — they intercept every `Bash|Write|Edit|Read|NotebookEdit|Agent` tool call, running safety checks (e.g. blocking unsafe `find`, writes to main branch, manual migrations) before the tool executes. The hook entry point is `bun tooling/src/guard.ts`, referenced in `.claude/settings.json`.

Guards are fully independent: no other tooling module imports from them, and they import nothing from tooling. This makes them the ideal first sub-plugin to migrate.

**Risk:** If the `.claude/settings.json` hook path is wrong after migration, all Claude Code tool calls will be affected — either silently unguarded or actively broken. The path update must be atomic with the file move.

## Plan

### Step 1: Create the sub-plugin directory

Create `plugins/framework/plugins/tooling/plugins/guards/` with `core/` and `bin/` subdirectories.

### Step 2: Move guard files into `core/`

Move the entire `tooling/src/guards/` contents into `core/`, preserving the internal directory structure. All relative imports between files are preserved because the subtree moves as a unit.

| Source | Destination |
|--------|-------------|
| `tooling/src/guards/types.ts` | `core/types.ts` |
| `tooling/src/guards/define-guard.ts` | `core/define-guard.ts` |
| `tooling/src/guards/context.ts` | `core/context.ts` |
| `tooling/src/guards/parse-shell.ts` | `core/parse-shell.ts` |
| `tooling/src/guards/runner.ts` | `core/runner.ts` |
| `tooling/src/guards/index.ts` | `core/index.ts` |
| `tooling/src/guards/guards/*.ts` (8 files) | `core/guards/*.ts` |
| `tooling/src/guards/hints/index.ts` | `core/hints/index.ts` |
| `tooling/src/guards/hints/package-json.ts` | `core/hints/package-json.ts` |

No import changes needed within these files — relative paths are preserved.

### Step 3: Move entry point to `bin/guard.ts`

Move `tooling/src/guard.ts` → `bin/guard.ts`.

**One import change:** `import { runHook } from "./guards/runner"` → `import { runHook } from "../core/runner"`.

### Step 4: Update `.claude/settings.json`

Change the PreToolUse hook command:
```
"bun tooling/src/guard.ts"
→
"bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts"
```

### Step 5: Delete old files

- Delete `tooling/src/guards/` (entire directory)
- Delete `tooling/src/guard.ts`

### Critical files

- `.claude/settings.json:29` — PreToolUse hook command
- `tooling/src/guard.ts` — entry point (moves to `bin/guard.ts`)
- `tooling/src/guards/runner.ts` — hook runner (moves to `core/runner.ts`)
- `tooling/src/guards/index.ts` — guard registry + barrel (moves to `core/index.ts`)

## Verification

1. **Type-check:** The tooling `tsconfig.json` already includes `plugins/*/core` and `plugins/*/bin` — the new files will be picked up automatically.
2. **Hook fires:** In a fresh Claude Code session, run any Bash command. The PreToolUse hook must still intercept (e.g. running `find /` should be blocked by the find guard).
3. **No stale refs:** `rg 'tooling/src/guard' --type ts` should return nothing.
4. **Build:** `./equin build` succeeds (guards contribute no runtime plugins, so `plugins.generated.ts` should be unchanged).
