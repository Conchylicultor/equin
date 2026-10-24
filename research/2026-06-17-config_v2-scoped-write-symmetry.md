# config_v2: make scoped read/write symmetric (kill silent scoped-write loss)

## Context

`config_v2` lets a consumer read and write a descriptor's config under an app
scope: `useConfig(d, { scopeId })` / `useSetConfig(d, { scopeId })`. Today the
two ends disagree about when a scope is "active":

- **Write** (`useSetConfig` → `POST /set-field` → `setConfig`) writes to the
  scoped key **whenever `scopeId` is present**, unconditionally.
- **Read** (`useConfig`) only *subscribes* to the scoped key when
  `useScoped = !!scopeId && (forked || hasCommittedScope)`
  (`plugins/config_v2/web/internal/use-config.ts:60`). `forked` is the
  scope-level theme-fork flag; `hasCommittedScope` is a boot-static set of
  git-committed scopes.

Consequence: a scoped write against a scope that is neither theme-forked nor
git-committed lands on disk + in the server cache, but `useConfig` stays
subscribed to the **global** key and never sees it. The edit applies
optimistically, then **vanishes on reload — no error, no warning**. This already
bit the data-view named-view-instance writes; the workaround was to drop
`scopeId` entirely (`plugins/primitives/plugins/data-view/web/internal/use-views-config.ts:64-68`),
which removes per-app scoping rather than fixing the primitive. The footgun
remains for every `config_v2` consumer that passes a `scopeId`.

The root cause is a **duplicated, weaker client-side re-derivation** of a
predicate the server already owns. The server resolves scoped-vs-base via
`scopeHasOwnConfig(descriptor, scopeId)` — true iff the scope's origin OR
override file exists (`plugins/config_v2/server/internal/resource.ts:295`) — and
already publishes the exact per-descriptor list of such scopes live through
`configV2ScopesResource` (`config-v2.scopes`, keyed by `{ path }`,
`resource.ts:205-220`), re-notified on every scoped file change
(`registry.ts:141-143`, `registry.ts:237`). The client just isn't using it.

### Intended outcome

1. **Read honors any existing scoped override.** Drive `useConfig`'s scoped
   decision from the authoritative `configV2ScopesResource`, so read/write/server
   all key off one predicate (`scopeHasOwnConfig`). No divergence is possible.
2. **Fork-on-write.** A scoped `setConfig` to a scope with no own config
   auto-creates it (snapshot base → scope) instead of throwing. Writing to a
   scope makes it exist *and* readable — fully symmetric, no fork ceremony.

After both, the only loud failure left is the legitimate one: a write when
`./equin build` was never run (no base origin at all).

## Approach

### 1. Read path — authoritative scoped decision (`use-config.ts`)

Replace the `forked || hasCommittedScope` heuristic with membership in the live
`configV2ScopesResource` list:

```ts
// use-config.ts
import { configV2Resource, configV2ScopesResource } from "@plugins/config_v2/core";
// (drop useScopeForked + useHasCommittedScope imports)

const scopeId = opts?.scopeId;
// Called unconditionally (Rules of Hooks); result only consulted when scopeId set.
const scopesRes = useResource(configV2ScopesResource, { path });
const useScoped = !!scopeId && (scopesRes.data ?? []).includes(scopeId);
const globalRes = useResource(configV2Resource, { path });
const scopedRes = useResource(configV2Resource, useScoped ? { path, scopeId } : { path });

if (useScoped && !scopedRes.pending) return scopedRes.data as ConfigValues<F>;
if (!globalRes.pending) return globalRes.data as ConfigValues<F>;
return descriptor.defaults as ConfigValues<F>;
```

`configV2ScopesResource` has `initialData: []`, so it never collapses to
pending; while it loads, `useScoped` is `false` and the reader falls back to the
global value — the existing documented-correct fallback (an untracked scope
resolves server-side to exactly the global value).

This single signal subsumes all three cases:
- committed git scope → in `discoverScopeIds` ∩ `scopeHasOwnConfig` → listed,
- runtime theme fork (override file) → listed,
- **plain scoped `setConfig` write (the bug)** → scoped override created →
  listed → now read.

It is reactive in-session (the scopes resource re-notifies when scoped files
appear) and correct on reload (loader is authoritative).

### 2. Boot — keep committed scopes flash-free (`boot.ts`)

`config-v2.scopes` is a push resource, not boot-hydrated, so committed scopes
would flash global→scoped on first paint without seeding. The boot snapshot
already returns `scopes: [{ scopeId, path, values }]`
(`server/internal/resource.ts:108-116`). Group by `path` and hydrate the scopes
resource alongside the already-hydrated scoped values:

```ts
// boot.ts, after hydrating scoped values
const byPath = new Map<string, string[]>();
for (const s of scopes ?? []) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s.scopeId]);
for (const [path, ids] of byPath) hydrateResource(configV2ScopesResource, { path }, ids);
```

Then on first frame `useConfig` sees the committed scopeId in the list →
`useScoped` true → reads the pre-hydrated scoped value. No flash. Runtime forks
keep their existing (unchanged) one-frame fallback behavior on reload.

Drop the `setCommittedScopes(...)` call and the `setKnownServerPaths` logic stays
as-is.

### 3. Delete the now-dead committed-scopes store

`plugins/config_v2/web/internal/committed-scopes.ts` is used **only** by
`boot.ts` + `use-config.ts` (confirmed by grep). Delete the file. **Keep**
`useScopeForked` (still consumed by theme-toggle / theme-engine /
theme-customizer) — only remove its use *inside* `useConfig`.

### 4. Fork-on-write (`server/internal/registry.ts` `setConfig`)

Today `setConfig` throws when neither scoped override nor scoped origin exists
(`registry.ts:441-452`). Change the **scoped** case: if `scopeId` is set, the
scoped origin/override are absent, but the **base** origin exists, snapshot the
base-effective values into the scoped origin first (the same snapshot
`forkDescriptor` writes), then proceed normally (the existing path reads that
origin as the base and writes the override with the changed field).

- Reuse `forkDescriptor`'s logic — snapshot `getConfig(descriptor, scopeId)`
  (resolves to base for a fresh scope), **redact storage-provider (secret)
  fields**, write `@app/<id>/<name>.origin.jsonc`. To avoid a registry→scope-fork
  module cycle, extract the snapshot-origin write into a small shared internal
  helper (e.g. `writeScopedOriginSnapshot(descriptor, hierarchyPath, scopeId)` in
  a new `scope-snapshot.ts`) and call it from both `forkDescriptor`
  (`scope-fork.ts`) and `setConfig` (`registry.ts`) so the two never drift.
- **Preserve the legitimate loud failure:** if the *base* origin is also missing
  (build never ran), still throw the existing "run ./equin build" error.
  Fork-on-write applies to scoped writes only — base (`scopeId === ""`) writes are
  unchanged.
- After fork-on-write, surface the scope-membership flip promptly (rather than
  waiting on the 100ms watcher debounce) by calling
  `notifyDescriptorScopeChange(entry.storePath, scopeId)` once, mirroring
  `forkDescriptorScope` (`scope-fork.ts:94-98`). The subsequent override write is
  picked up by the entry's watcher as today.

`ensureScopeEntry` is already called at the top of the scoped `setConfig` path
(`registry.ts:404-405`), so the scoped entry + its file watchers exist before the
snapshot write.

### 5. Revert the data-view workaround

In `plugins/primitives/plugins/data-view/web/internal/use-views-config.ts`,
restore the per-app `scopeId` now that scoped writes are symmetric:

```ts
const appId = useCurrentAppId();
const scopeId = appId ? appScopeId(appId) : undefined;
const config = useConfig(descriptor, { scopeId });
const setConfig = useSetConfig(descriptor, { scopeId });
```

Remove the workaround comment block (`use-views-config.ts:64-68`) and update the
matching note in the data-view `CLAUDE.md` (lines ~50-53). Confirm `appScopeId`
is the right helper (`@plugins/config_v2/core`); keep the `useCurrentAppId` import
that already exists in that subtree.

## Critical files

- `plugins/config_v2/web/internal/use-config.ts` — swap the scoped gate.
- `plugins/config_v2/web/internal/boot.ts` — hydrate `configV2ScopesResource`.
- `plugins/config_v2/web/internal/committed-scopes.ts` — **delete**.
- `plugins/config_v2/server/internal/registry.ts` — fork-on-write in `setConfig`.
- `plugins/config_v2/server/internal/scope-snapshot.ts` — **new** shared helper
  (extracted from `scope-fork.ts` `forkDescriptor`).
- `plugins/config_v2/server/internal/scope-fork.ts` — call the shared helper.
- `plugins/primitives/plugins/data-view/web/internal/use-views-config.ts` —
  restore `scopeId`.
- `plugins/config_v2/CLAUDE.md` + data-view `CLAUDE.md` — doc updates.

## Reuse (don't reinvent)

- `configV2ScopesResource` / `computeDescriptorScopes` — the authoritative scoped
  list already published live (`server/internal/resource.ts:205-220`).
- `scopeHasOwnConfig` — the single predicate read/write/resolve must share
  (`server/internal/resource.ts:295`).
- `forkDescriptor` snapshot + secret redaction logic (`scope-fork.ts:19-33`) —
  extracted, not duplicated.
- `notifyDescriptorScopeChange` (`registry.ts:233-238`) — prompt scope-flip fan-out.
- `hydrateResource`, `useResource` (live-state) — already imported.

## Verification

1. `./equin build` (regenerates, type-checks, restarts server).
2. `./equin check` — expect `plugins-doc-in-sync` to require the doc edits
   above; `config-origins-in-sync` unaffected (no committed config changes).
3. **Unit:** add a `bun:test` next to `registry.ts` for `setConfig` fork-on-write:
   - scoped write to a fresh scope (base origin present) creates
     `@app/<id>/<name>.origin.jsonc` + `.jsonc` and `scopeHasOwnConfig` becomes
     true;
   - scoped write with **no base origin** still throws the build error;
   - base write unchanged.
4. **End-to-end (the original bug), via `e2e/screenshot.mjs` against
   `http://<worktree>.localhost:9000`:** open a data-view surface scoped to an
   app, edit a named view instance, **reload**, confirm the edit persists.
   Cross-check with the MCP `query_db`? — N/A (config is file-backed, not DB);
   instead inspect
   `~/.singularity/config/<wt>/<hier>/@app/<id>/views.jsonc` to confirm the
   scoped override exists with a valid `// @hash`.
5. Confirm theme per-app customization (theme-toggle / customizer) still works —
   it uses the retained `useScopeForked` and the same scopes resource.

## Out of scope

- The scope **snapshot semantics** are unchanged: fork-on-write freezes the
  descriptor's other fields at the current base for that app (identical to
  explicit `forkDescriptorScope`). This is the documented per-app scope model.
- No change to the staging / `promotableToGit` git-promotion flow.
