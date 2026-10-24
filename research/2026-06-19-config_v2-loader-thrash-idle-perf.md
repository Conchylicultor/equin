# config_v2 loader thrash + slow config pages

**Date:** 2026-06-19
**Category:** config_v2
**Related (complementary, not blocking):** [`research/2026-06-19-global-live-state-unified-read-path-v2.md`](./2026-06-19-global-live-state-unified-read-path-v2.md) — a framework-level runtime read-through cache. That plan caches resource *values*; this plan reduces the *work each load/refill does* and kills idle invalidation. They compose: even with a runtime cache, the conflicts loader scanning 180 descriptors per refill, the scopes disk-walk per refill, and a 30 s timer invalidating everything are all still wrong at the config_v2 layer.

## Context

Loading one config page (e.g. `/settings/config/cd/apps%2Fdeploy%2Fservers%2Fdeploy.servers.jsonc`) takes >4 s, and `config-v2.scopes` / `config-v2.conflicts` loaders dominate idle load on the main backend. Four structural causes, all in `plugins/config_v2`:

1. **A 30 s blanket reconcile storm.** `createFileWatcher` defaults `reconcileMs = 30_000` (`plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts:29,112`). `config-watcher.ts`'s `onReconcile` calls `notifyWatchers(abs)` for **every** watched path (2 per descriptor). Each `onFileChange` re-reads files from disk and fires `notifyValues` + `notifyConflicts` + `notifyTiers` + a scopes notify — so every 30 s, at idle, ~2N watcher callbacks each trigger a full conflicts rescan → O(N²) disk I/O with nothing changed. Config files change **only via this process** (`setConfig` writes, `./equin build` propagation, fork) and the parcel watcher already catches every real disk write, so the reconcile is pure churn.

2. **`config-v2.conflicts` re-walks ALL ~180 descriptors from disk on every load.** `computeAllConflicts(scopeId)` (`resource.ts:112`) loops the whole registry, reading 2–3 JSONC files per descriptor, with no memoization. The resource is keyed only by `{ scopeId }` (returns the whole map), so a change to one descriptor re-notifies base + every known scope, each re-running the full scan. The config-detail page subscribes to this whole-map resource but only needs **one** descriptor's conflict.

3. **`config-v2.scopes` re-walks the filesystem on every load.** `computeDescriptorScopes(path)` (`resource.ts:191`) does a `readdirSync` of the `@app/` dir + 2 `existsSync` per scope, on every load — even though the membership it derives (`scopeHasOwnConfig`) only changes when a scoped file appears/disappears.

4. **Per-path scopes subscription fan-out.** `useConfig` subscribes to `config-v2.scopes` keyed `{ path }` once per descriptor (`use-config.ts:58`); `useScopeMembership` and `scope-tabs` do too. The theme injector loops `useScopeMembership` over every token descriptor group app-wide, so subscriptions fan out as `paths × open tabs` and **all replay on every WS reconnect**, each replay re-running the disk walk.

Goal: idle config load drops to ~zero, a single config page loads fast, and a scope/conflict change touches only the affected descriptor.

## Approach

Four independent, ordered changes. The guiding principle: **a loader read is an in-memory read; disk is touched only when a config file actually changes.** This mirrors the existing in-memory pattern (`jsonlEventsResource`: watcher populates a `Map`, loader reads it) and preserves config_v2's load-bearing invariant that `scopeHasOwnConfig` (disk) stays the *authoritative* predicate — we recompute from it on real changes and cache the result, never mirror it speculatively.

### Change 1 — Drop the 30 s reconcile for config (highest impact, lowest risk)

`plugins/config_v2/server/internal/config-watcher.ts`: pass `reconcileMs: null` to `createFileWatcher` and delete the `onReconcile` handler. The parcel subscription (real fs events, debounced 100 ms / ceiling 1 s) already fires on every disk write regardless of which process wrote it, so no real change is missed. Add a comment stating why (config files mutate only in-process or via build; parcel covers out-of-band edits).

- **Do not** change the `createFileWatcher` default — other consumers (transcript-watcher, midi folders, prototypes/files) legitimately rely on reconcile for externally-mutated files. This is a config-watcher-local opt-out.
- Eliminates the entire idle storm. With it gone, the remaining loaders only run on real changes + subscribe/reconnect.

### Change 2 — In-memory scope membership + collapse fan-out to one global resource

Make scopes a single global map resource computed from an in-memory map, subscribed once per tab.

**Core** (`plugins/config_v2/core/internal/resource.ts`):
- Add `configV2ScopesMapSchema = z.record(z.array(z.string()))` and `type ConfigV2ScopesMap = Record<string, string[]>` (storePath → scopeIds). Keep `ConfigV2Scopes = string[]` as the per-descriptor element type (still returned by the snapshot).
- Re-key `configV2ScopesResource` to `resourceDescriptor<ConfigV2ScopesMap, {}>` ("config-v2.scopes", `configV2ScopesMapSchema`, initial `{}`).

**Server** (`resource.ts`):
- Add module-level `const scopeMembers = new Map<string, string[]>()` (storePath → scopeIds; omit empties). Single source the loader reads.
- `refreshScopeMembers(storePath)`: recompute via `discoverScopeIds(hierarchyPath).filter(scopeHasOwnConfig)` (the authoritative disk predicate — runs only on real change), update `scopeMembers`, and `configV2ScopesServerResource.notify({})` if the entry changed. Export it.
- Replace `computeDescriptorScopes` loader with one keyed `{}` returning `Object.fromEntries(scopeMembers)` (pure memory).

**Server** (`registry.ts`):
- In `initRegistry`, after the rehydration loop, call `refreshScopeMembers(storePath)` for each registered descriptor (warms the map at boot; reuses the `discoverScopeIds` it already runs).
- Replace `configV2ScopesServerResource.notify({ path })` at `registry.ts:139` (onFileChange) and `:234` (`notifyDescriptorScopeChange`) with `refreshScopeMembers(storePath)`.

**Web** — subscribe once, `select` per descriptor:
- `use-config.ts:58`: `useResource(configV2ScopesResource, {}, { select: (m) => scopeId ? (m[path] ?? []).includes(scopeId) : false })` — same boolean, re-render still gated to this path's flip.
- `use-scope-membership.ts:31`: same select shape (boolean for its scopeId).
- `scope-tabs.tsx:40`: `useResource(configV2ScopesResource, {}, { select: (m) => m[storePath] ?? [] })` to get the list.
- `boot.ts:25-32`: hydrate the single map — `hydrateResource(configV2ScopesResource, {}, byPathObject)` instead of the per-path loop.

Result: one `config-v2.scopes` subscription per tab (shared via the socket), one replay per reconnect, loader is a memory read.

### Change 3 — Per-descriptor conflicts + incremental conflict-paths

**Core** (`resource.ts`):
- Re-key `configV2ConflictsResource` to `resourceDescriptor<ConfigV2ConflictEntry | null, { path: string; scopeId?: string }>` returning one entry (add a `configV2ConflictEntryOrNull` schema = `configV2ConflictEntrySchema.nullable()`). Keep `configV2ConflictsSchema` (the map) only if still needed by the snapshot; otherwise retire it.

**Server** (`resource.ts`):
- Extract the per-descriptor body of `computeAllConflicts` into `computeDescriptorConflict(storePath, scopeId): ConfigV2ConflictEntry | null`. Rewrite the conflicts loader to call it for `{ path, scopeId }` (in-memory descriptor lookup + reads only that descriptor's 2–3 files).
- `conflict-paths`: add module-level `const conflictPaths = new Set<string>()`. `refreshConflictPaths(storePath)`: a descriptor is "conflicting" if `computeDescriptorConflict` is non-null for base **or any** of its scopes (`scopeMembers.get(storePath)`); add/remove the path and `notify({})` if the set changed. Loader returns `[...conflictPaths]` (memory). Populate in `initRegistry`. This replaces `computeConflictPaths`'s 1 + N_scopes full scans.

**Server** (`registry.ts`) — `notifyConflicts(storePath, scopeId)`:
- Replace the whole-map notifies with per-path: `configV2ConflictsServerResource.notify({ path: storePath, scopeId })`, and the un-forked-scope loop now notifies `{ path: storePath, scopeId: sid }` (same fan-out, now scoped to this descriptor's path).
- Replace `configV2ConflictPathsServerResource.notify({})` with `refreshConflictPaths(storePath)`.

**Web** (`plugins/config_v2/plugins/settings`):
- `use-conflicts.ts`: `useConflicts(scopeId)` → `useConflict(storePath, scopeId)` returning `ResourceResult<ConfigV2ConflictEntry | null>` via `useResource(configV2ConflictsResource, { path: storePath, ...(scopeId ? { scopeId } : {}) })`. `useConflictPaths()` unchanged.
- `config-detail.tsx:79`: call `useConflict(storePath, scopeId)`; read `conflictRes.data` directly (was `conflicts.data[storePath]`).
- `scope-tabs.tsx:92`: `useResource(configV2ConflictsResource, { path: storePath, ...(scopeId ? { scopeId } : {}) })`; the dot now keys off `res.data != null`.

Result: opening one config page recomputes exactly one descriptor's conflict; the nav badge set is a memory read updated incrementally.

### Change 4 — (optional, same pattern) modified-counts

`computeModifiedCounts` (`resource.ts:241`) recomputes all ~180 descriptors on every value change, keyed `{}`. It reads the in-memory `configGetter` (no disk), so with the reconcile gone it only runs on real edits. Leave functionally as-is; note as a follow-up that it could be made incremental (per-descriptor count cached, recomputed on that descriptor's value change) using the same `refresh*` pattern if it shows up in profiling.

## Critical files

- `plugins/config_v2/server/internal/config-watcher.ts` — drop reconcile (Change 1).
- `plugins/config_v2/server/internal/resource.ts` — `scopeMembers` + `refreshScopeMembers`, `conflictPaths` + `refreshConflictPaths`, `computeDescriptorConflict`, re-keyed scopes/conflicts loaders.
- `plugins/config_v2/server/internal/registry.ts` — call `refreshScopeMembers` / `refreshConflictPaths` at boot + on change; per-path conflict notifies.
- `plugins/config_v2/core/internal/resource.ts` — re-key `configV2ScopesResource` (map, `{}`) and `configV2ConflictsResource` (`{ path, scopeId? }` → entry|null); new schemas.
- `plugins/config_v2/web/internal/{use-config,use-scope-membership,boot}.ts` — single global scopes subscription + select; hydrate map.
- `plugins/config_v2/plugins/settings/web/internal/use-conflicts.ts` + `components/{config-detail,scope-tabs}.tsx` — per-descriptor conflict hook.
- Reference pattern: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-events-resource.ts` (watcher-populated in-memory map + loader reads it).

## Verification

1. `./equin build` from the worktree; confirm clean boot (`~/.singularity/worktrees/<wt>/logs/server.jsonl` shows no config-v2 errors).
2. **Idle storm gone:** with the app open and idle for >60 s, `mcp__singularity__get_runtime_profile kind:"loader"` shows **no** periodic `config-v2.conflicts` / `config-v2.scopes` / `config-v2.conflict-paths` loader runs (pre-fix: a burst every 30 s).
3. **Fast page:** reload `http://<wt>.localhost:9000/settings/config/cd/apps%2Fdeploy%2Fservers%2Fdeploy.servers.jsonc` via `bun e2e/screenshot.mjs`; the profiler shows the conflicts loader scanning one descriptor, page interactive well under the prior >4 s.
4. **Correctness — scopes:** in settings, fork an app scope for a descriptor (`+ App`), edit a field; the scope tab + conflict dot still appear, `useConfig({ scopeId })` resolves scoped values, and "Stop customizing" reverts — exercising `refreshScopeMembers` add/remove. Confirm via the UI and `mcp__singularity__query_db` against the config dir state.
5. **Correctness — conflicts:** trigger a stale override (edit `~/.singularity/config/<wt>/.../config.jsonc` `@hash`); the detail page shows the conflict banner and the nav/sidebar dot lights, confirming per-descriptor notify + `refreshConflictPaths`. Resolve it; dot clears.
6. **Fan-out:** with the theme injector mounted (any app), `mcp__singularity__get_runtime_profile` / the live-state health debug pane shows a single `config-v2.scopes` subscription, not one per token descriptor.
7. `./equin check` passes (boundaries, type-check, plugins-doc-in-sync).
