# Re-home top-level leaf plugins under semantic umbrellas

**Date:** 2026-06-12
**Category:** global
**Status:** Plan — awaiting approval

## Context

The top-level `plugins/` folder is meant to read as a list of **semantic categories**, not a flat dumping ground. CLAUDE.md already mandates: *"Group related plugins under an umbrella. For 2+ related plugins, prefer an umbrella parent over flat top-level entries."* Today 13 top-level entries are **leaf plugins** (zero sub-plugins), polluting that category list. This refactor re-homes every leaf under an existing umbrella so the top level contains only umbrellas. No new umbrellas are created. Behavior is unchanged — this is a pure relocation.

## The 13 moves

| # | Current | Target | New plugin id |
|---|---|---|---|
| 1 | `plugins/agents` | `plugins/conversations/plugins/agents` | `conversations.agents` |
| 2 | `plugins/attempt-view` | `plugins/tasks/plugins/attempt-view` | `tasks.attempt-view` |
| 3 | `plugins/collections` | `plugins/primitives/plugins/collections` | `primitives.collections` |
| 4 | `plugins/conversations-recover` | `plugins/conversations/plugins/recover` | `conversations.recover` |
| 5 | `plugins/events-test` | `plugins/infra/plugins/events-test` | `infra.events-test` |
| 6 | `plugins/floating-bar` | `plugins/shell/plugins/floating-bar` | `shell.floating-bar` |
| 7 | `plugins/health` | `plugins/infra/plugins/health` | `infra.health` |
| 8 | `plugins/notifications` | `plugins/shell/plugins/notifications` | `shell.notifications` |
| 9 | `plugins/tasks-core` | `plugins/tasks/plugins/tasks-core` | `tasks.tasks-core` |
| 10 | `plugins/terminal` | `plugins/primitives/plugins/terminal` | `primitives.terminal` |
| 11 | `plugins/theme` | `plugins/ui/plugins/theme-toggle` | `ui.theme-toggle` |
| 12 | `plugins/welcome` | `plugins/apps/plugins/agent-manager/plugins/welcome` | `apps.agent-manager.welcome` |
| 13 | `plugins/worktree-switcher` | `plugins/apps/plugins/agent-manager/plugins/worktree-switcher` | `apps.agent-manager.worktree-switcher` |

All target umbrellas already exist with a `plugins/` subdir and auto-discover new children. `primitives`, `ui`, `infra`, `apps/.../agent-manager` are pure-folder umbrellas; `conversations`, `tasks`, `shell`, `apps` are plugin+umbrellas. No cycles introduced (`tasks` plugin → `tasks/plugins/tasks-core` is a clean parent→foundational-child edge; tasks-core imports nothing from `tasks`).

## What a move touches (verified mechanics)

| Surface | Update | Auto via `build`? |
|---|---|---|
| `*.generated.ts` registries (`web-sdk/core/web.generated.ts`, `server-core/core/server.generated.ts`, `checks/core/check.generated.ts`) + `dependsOn` arrays | regenerated from disk | ✅ **Do not hand-edit** |
| `reorder/shared/reorderable-slots.generated.ts` (`pluginId` field) | regenerated | ✅ |
| `docs/plugins-compact.md`, `docs/plugins-details.md`, per-plugin `CLAUDE.md` autogen blocks | regenerated (`plugins-doc-in-sync` check gates) | ✅ |
| Cross-plugin import specifiers `@plugins/<old>/{web,server,core}` | rewrite to new path | ❌ **manual (scripted)** |
| `config/<old-hierarchy>/` dirs | `git mv` to new hierarchy path | ❌ **manual** |
| `plugin_health_reviews.plugin_id` rows | orphaned (accepted — regenerable per-worktree DB state) | n/a |

- **`@plugins/*` resolution is pure path-based** — alias declared once in `tsconfig.base.json:15` (`"@plugins/*": ["./plugins/*"]`) and `web-core/vite.config.ts:18`. No mapping file to update; the new nested paths resolve automatically.
- **Slot/command/event ids are author-chosen string literals**, *not* path-derived (`web-sdk/core/slots.ts:15`, `commands.ts:3`). They do **not** change on move — contributors keep working.
- **No existing tooling** moves/renames a plugin; this is bespoke.
- **`boundary-config.ts`** hardcodes only `plugin-meta` and `packages` — **none of the 13** appear, so no boundary-config edits needed.
- **Only 2 plugins have `config/` dirs:** `config/agents/` (10 files) → `config/conversations/agents/`; `config/floating-bar/` (1 file) → `config/shell/floating-bar/`. (`// @hash` anchors are content-based, survive the dir move.)

### Import-rewrite substitution table (anchored on trailing `/`)

```
@plugins/agents/                 → @plugins/conversations/plugins/agents/
@plugins/attempt-view/           → @plugins/tasks/plugins/attempt-view/
@plugins/collections/            → @plugins/primitives/plugins/collections/
@plugins/conversations-recover/  → @plugins/conversations/plugins/recover/
@plugins/events-test/            → @plugins/infra/plugins/events-test/
@plugins/floating-bar/           → @plugins/shell/plugins/floating-bar/
@plugins/health/                 → @plugins/infra/plugins/health/
@plugins/notifications/          → @plugins/shell/plugins/notifications/
@plugins/tasks-core/             → @plugins/tasks/plugins/tasks-core/
@plugins/terminal/               → @plugins/primitives/plugins/terminal/
@plugins/theme/                  → @plugins/ui/plugins/theme-toggle/
@plugins/welcome/                → @plugins/apps/plugins/agent-manager/plugins/welcome/
@plugins/worktree-switcher/      → @plugins/apps/plugins/agent-manager/plugins/worktree-switcher/
```

Each source name is a distinct top-level folder; trailing-slash anchoring prevents partial matches (e.g. `@plugins/health/` won't touch a hypothetical `@plugins/health-x`). No rule's output matches another rule's input, so a single pass is order-independent and idempotent. Blast radius (non-registry importers): `tasks-core` 120, `notifications` 34, `attempt-view` 3, `terminal` 1, all others 0.

## Execution: scripted core + parallel verify fleet

### Step 1 — Scripted deterministic core (serial, one operator)
Run as a single sequential pass to avoid `.git/index.lock` races and same-file edit races (note `notify-created-job.ts`, `record-crash.ts`, `exit-clean-finalize-job.ts` import *both* tasks-core and notifications — why per-plugin parallelism is unsafe):

1. `git mv` each of the 13 plugin folders to its target (creating intermediate dirs as needed).
2. `git mv config/agents config/conversations/agents` and `git mv config/floating-bar config/shell/floating-bar`.
3. Apply the 13-entry substitution table across all `**/*.{ts,tsx}` (single global pass). **Skip the `*.generated.ts` files** — they get rebuilt.

### Step 2 — Parallel Sonnet verify fleet (6 agents, file-disjoint by umbrella)
Each agent audits its umbrella's moved plugins and fixes only **residual / non-type-checked** references the scripted pass can't catch (dynamic `import()` with template strings, references in `*.md`, `*.json`, comments, test fixtures):

- **A1 — conversations:** `agents`, `recover`
- **A2 — tasks:** `tasks-core`, `attempt-view`
- **A3 — shell:** `notifications`, `floating-bar` (+ confirm `config/shell/floating-bar/` moved)
- **A4 — infra:** `health`, `events-test`
- **A5 — primitives+ui:** `collections`, `terminal`, `theme-toggle`
- **A6 — apps/agent-manager:** `welcome`, `worktree-switcher`

Each agent: (a) `rg "@plugins/<old-name>/"` returns **zero** hits anywhere; (b) the new folder's barrel + intra-plugin relative imports are intact; (c) `config/` dir moved where applicable; (d) report anything unexpected. Agents make small fixes only — no structural changes.

### Step 3 — Regenerate + validate (serial)
1. `./equin build` — regenerates all `*.generated.ts`, `reorderable-slots.generated.ts`, docs, and config origins; restarts server.
2. `./equin check` — must pass: `type-check` (catches every broken import), `migrations-in-sync`, `plugins-doc-in-sync`, `config-origins-in-sync`, reorder-slots sync, and `plugin-boundaries`.
3. Fix any check failures, rebuild, re-check until green.

## Critical files

- `tsconfig.base.json` (alias — read-only, confirms no change needed)
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` (regen source — read-only)
- `plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts` (confirm no edits)
- `config/agents/` → `config/conversations/agents/`; `config/floating-bar/` → `config/shell/floating-bar/`
- The 13 plugin folders + ~140 importer files (mostly tasks-core/notifications consumers in the `conversations`/`tasks` subtrees)

## Verification (end-to-end)

1. `rg -n "@plugins/(agents|attempt-view|collections|conversations-recover|events-test|floating-bar|health|notifications|tasks-core|terminal|theme|welcome|worktree-switcher)/"` → **zero hits** (the bare old paths are gone).
2. `./equin check` → all checks green (type-check proves every import resolves; doc/config/reorder sync checks prove codegen + config moves are consistent).
3. `./equin build` succeeds and server boots.
4. Smoke test via Playwright at `http://<worktree>.localhost:9000`: app loads, the agent-manager shell renders, and spot-check the moved surfaces — light/dark toggle (`theme-toggle`), worktree switcher dropdown, floating action bar, welcome/landing pane, notifications bell, a task detail pane (`tasks-core` consumers), an agents list. Capture a before/after screenshot.
5. `git diff --stat $(git merge-base HEAD main)` — confirm the diff is only renames + import-string edits + regenerated artifacts, no logic changes.

## Notes / accepted side effects

- `plugin_health_reviews` rows keyed by the old dot-ids are orphaned. These are regenerable per-worktree review-tracking rows, not committed state — accepted, no migration written.
- This is a wide, mechanical diff (~150 files). Best landed as one focused commit so reviewers see it as a pure relocation. Do **not** push without explicit approval.
