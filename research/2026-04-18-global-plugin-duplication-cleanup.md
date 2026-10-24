# Plugin Duplication Cleanup

## Context

An audit surfaced ~12 duplication sites accumulated across plugins. This plan applies the module-boundary conventions from the companion plan (`2026-04-18-global-plugin-module-boundaries.md`) to clean them up: a new `tree` library plugin for hierarchy utilities, framework glue hoisted to `plugin-core`, domain-specific helpers re-homed to their owner plugin's `api.ts`, and a handful of trivial deletions.

This plan does not depend on the conventions plan landing first — the rules can be applied manually. But if the `plugin-boundaries` check lands before this work, it will verify each step as it proceeds. Two of the larger refactors (CRUD handler factory, typed `useResource`) are deferred to follow-up plans because they warrant their own design.

## Phase 1 — Trivial deletions

All atomic, no new abstractions, no cross-file coupling. Do first to shrink the surface.

- **Delete `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/prompt.ts`** — byte-identical to `server/internal/prompt.ts`, no imports found.
- **Inline `plugins/conversations/server/model.ts`** (5-line enum definition) into `plugins/conversations/server/schema.ts`. Update any imports.
- **Delete `plugins/conversations/shared/types.ts`** (10-line pure re-export barrel). Update consumers to import directly from the source.
- **Remove the `ConversationState` alias** at `plugins/conversations/plugins/conversation-view/web/slots.ts:5` — it is a transparent alias for `ConversationRecord`. Replace with direct use of `ConversationRecord` throughout the file.
- **Remove `console.log` at `plugins/tasks/server/index.ts:37`** — inconsistent with rest of codebase.

**Verification:** `./equin build` succeeds; frontend and server compile.

## Phase 2 — Re-home to existing owners

Move duplicated symbols into the `api.ts` of the plugin that already owns the domain. No new plugins needed.

### 2a. `CONV_STATUS_DOT` → `plugins/conversations/shared/api.ts`

The status-color mapping currently lives in `plugins/agents/web/components/agent-launches.tsx:12`. Conversations is its natural owner.

- Create `plugins/conversations/shared/api.ts` if it does not exist.
- Move `CONV_STATUS_DOT` there (or into `plugins/conversations/web/api.ts` if it carries Tailwind class strings that are strictly frontend — probably `web/api.ts` is correct).
- Update `plugins/agents/web/components/agent-launches.tsx` to import from `@plugins/conversations/web/api`.
- Search for any other consumers and update them too.

### 2b. Audit `nextAgentRankUnder`

`plugins/agents/server/internal/rank.ts` defines `nextAgentRankUnder(parentId)`; `plugins/tasks/server/api.ts` already exports `nextRankUnder(parentId, executor?)` for a different table. Two other files in agents already import `nextRankUnder` from tasks (`plugins/agents/server/internal/handle-launch.ts:5`, `plugins/agents/server/internal/meta-agents.ts:3`) — suggesting the local `nextAgentRankUnder` may be stale dead code. 

**Step 1 — audit:** check whether `nextAgentRankUnder` is still called anywhere inside `plugins/agents/`. If not, delete it outright (no unification needed).

**Step 2 — if still used:** because the two functions target different tables (`tasks` vs `agents`), they are parallel implementations, not duplicates. Unification is a Phase 3 concern (create a generic rank helper in `plugins/tree/server/api.ts`).

## Phase 3 — New library plugins

### 3a. Extract `descriptor<T>()` to `plugin-core/shared`

The helper appears in 5 places, all byte-identical (`plugins/agents/shared/resources.ts:3`, `plugins/tasks/shared/resources.ts:3`, `plugins/conversations/shared/resources.ts:7`, `plugins/conversations/shared/fork-errors.ts:9`, `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/shared/resources.ts:7`). It is framework glue for resource identity in the push/invalidation protocol — belongs in `plugin-core`.

- Add `descriptor<T>(key: string)` to an appropriate file in `plugin-core/shared/` (e.g. `plugin-core/shared/resource.ts` — look for an existing file named after resources or create one).
- Update all 5 call sites to import from `@core/shared/resource` (or whatever path the plugin-core path alias resolves to).
- Delete the 5 local copies.

### 3b. Create `plugins/tree` library plugin

Hosts `isDescendant`, `buildTree`, `computeDrop` — the tree algorithms duplicated between tasks and agents. Follows the library-plugin pattern: trivial `PluginDefinition` with `contributions: []`, library surface in `api.ts`.

**Scaffold:**
```
plugins/tree/
├── package.json                   # @singularity/plugin-tree
├── shared/
│   └── api.ts                     # isDescendant, buildTree, computeDrop, TreeNode<T>
└── web/
    └── index.ts                   # trivial PluginDefinition
```

No `server/` folder in this phase — the web duplicates (tasks-list.tsx, agents-list.tsx) all use the pure array-based form. Server-side `isDescendant` is DB-bound and differs per table; defer to follow-up.

**`shared/api.ts` surface:**
```typescript
export interface TreeNode<T> { id: string; item: T; children: TreeNode<T>[]; }

export function buildTree<T extends { id: string; parentId: string | null; rank: string }>(
  rows: readonly T[]
): TreeNode<T>[];

export function isDescendant<T extends { id: string; parentId: string | null }>(
  rows: readonly T[], ancestorId: string, candidateId: string
): boolean;

export function computeDrop<T extends { id: string; parentId: string | null; rank: string }>(
  rows: readonly T[], draggedId: string, zone: DropZone, targetId: string
): { parentId: string | null; rank: string };
```

Parameterize by generic `T` constrained to the shape used in both plugins (`id`, `parentId`, `rank`).

**Consumers to update:**
- `plugins/tasks/web/components/tasks-list.tsx:99,128,145` — delete locals, import from `@plugins/primitives/plugins/tree/shared/api`.
- `plugins/agents/web/components/agents-list.tsx:40,54,71` — same.

**Register the plugin:**
- Append to `web/src/plugins.ts` (import + array entry).
- No server registration needed (no `server/index.ts`).

### 3c. Create `plugins/format` library plugin (optional — judge at implementation time)

`formatDate` (identical at `plugins/tasks/web/components/task-events.tsx:36` and `plugins/agents/web/components/agent-launches.tsx:19`) is small (~5 lines). Two choices:

- **Extract** to `plugins/format/web/api.ts` with trivial PluginDefinition. Follows the "if shared, then owned" rule cleanly.
- **Defer** until a third consumer appears. Two copies of a 5-line function is borderline; a whole plugin for it may be over-indexed on purity.

Recommendation: **extract.** The plan establishes the discipline; creating plugins is cheap once scaffolding exists. If more format utilities appear, they accumulate in the same plugin. Name: `format` (or `formatters` — judge at implementation).

## Phase 4 — Deferred (separate plans needed)

These items from the audit warrant their own design. Noted here to close the loop on what the full audit called out, but not planned in detail.

### CRUD handler boilerplate (audit #7)

10+ `handle-{list,get,delete,create,update}.ts` files across `plugins/tasks/server/internal/`, `plugins/agents/server/internal/`, with similar shapes but real semantic differences (transaction handling, custom filters, hook ordering). A factory is attractive but needs care — premature abstraction here would lock in a contract that individual handlers then need escape hatches from.

**Follow-up plan should:** diff two pairs of handlers side-by-side, extract the common shell (resource invalidation, error envelope, ID parsing), leave the per-handler logic as a callback. Possibly live in `plugin-core/server` as framework glue for REST-style resource endpoints.

### Typed `useResource()` wrapper (audit #12)

The four `as Type[]` casts in `agents-list.tsx:140`, `agent-detail.tsx:34`, `tasks-list.tsx:205`, `task-detail.tsx:65` are symptoms of `useResource()` returning loosely-typed data. Fix at the source in `plugin-core/web`: make `useResource<T>()` generic and tie its return type to the resource descriptor.

**Follow-up plan should:** inspect the current `useResource` signature and descriptor shape; thread `T` from the descriptor through the hook so no cast is needed at call sites.

### Server-side `isDescendant` unification

Server versions at `plugins/agents/server/internal/handle-update.ts:65` and `plugins/tasks/server/internal/handle-update.ts:67` differ meaningfully (transaction support). Unify into `plugins/tree/server/api.ts` as a parameterized `isDescendantInDb(db, tableRef, ancestorId, candidateId, executor?)`. Left out of Phase 3 because it's more than a mechanical move.

### Generic rank helper

If Phase 2b finds `nextAgentRankUnder` is still live, add a parameterized `nextRankUnder(db, tableRef, parentId, executor?)` to `plugins/tree/server/api.ts`. Refactor both `tasks/server/internal/rank.ts` and `agents/server/internal/rank.ts` to call through it. Their `api.ts` exports can remain as thin wrappers for backward compatibility.

## Files Changed Summary

### Created
- `plugins/tree/package.json`
- `plugins/tree/shared/api.ts`
- `plugins/tree/web/index.ts`
- `plugins/format/package.json` (if extracting formatDate)
- `plugins/format/web/api.ts` (if extracting formatDate)
- `plugins/format/web/index.ts` (if extracting formatDate)
- `plugins/conversations/shared/api.ts` or `plugins/conversations/web/api.ts` (for `CONV_STATUS_DOT`)
- A new file or addition in `plugin-core/shared/` for `descriptor<T>()`

### Modified
- `plugins/tasks/web/components/tasks-list.tsx` — import tree helpers from `@plugins/primitives/plugins/tree/shared/api`.
- `plugins/agents/web/components/agents-list.tsx` — same.
- `plugins/tasks/web/components/task-events.tsx` — import `formatDate` (if extracted).
- `plugins/agents/web/components/agent-launches.tsx` — import `formatDate` and `CONV_STATUS_DOT`.
- `plugins/conversations/plugins/conversation-view/web/slots.ts` — drop `ConversationState` alias.
- `plugins/tasks/server/index.ts` — remove `console.log`.
- `plugins/conversations/server/schema.ts` — absorb enum from `model.ts`.
- All 5 `descriptor<T>()` call sites — import from `@core/shared/...`.
- `web/src/plugins.ts` — register new library plugins.

### Deleted
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/prompt.ts`
- `plugins/conversations/server/model.ts`
- `plugins/conversations/shared/types.ts`
- Local `descriptor<T>()` in 5 files (leaving only the `plugin-core` copy).
- Local `isDescendant`, `buildTree`, `computeDrop` in `tasks-list.tsx` and `agents-list.tsx`.
- Local `formatDate` in `task-events.tsx` and `agent-launches.tsx` (if extracted).
- `plugins/agents/server/internal/rank.ts` if `nextAgentRankUnder` turns out dead (Phase 2b).

## Verification

1. Run `./equin build` after each phase. Expect clean build at each checkpoint.
2. Open the app at `http://<worktree>.localhost:9000` after Phase 3 and verify:
   - Tasks list still renders, drag-drop still works (buildTree/computeDrop regression surface).
   - Agents list renders and its drag-drop works.
   - Agent-launches panel still shows status dots with correct colors.
   - Task-events panel still shows formatted dates.
3. If `2026-04-18-global-plugin-module-boundaries.md` has landed first, run `./equin check --plugin-boundaries` — it should pass. Any violation means a symbol was moved to a non-barrel path; fix by re-exporting via `api.ts`.
4. If `plugins.md` generation was extended (per that plan), confirm new plugins (`tree`, `format`) appear with their `api.ts` exports listed.
5. Grep-verify each cleanup landed: e.g. `grep -r "function descriptor<T>" plugins/` should return zero hits after Phase 3a.
