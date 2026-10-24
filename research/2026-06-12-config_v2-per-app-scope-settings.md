# Per-app config scope settings surface

## Context

The `config_v2` plugin supports **per-app config scopes** — a descriptor's
config can be customized per app via a git-committed JSONC delta at
`config/<hier>/@app/<id>/<name>.jsonc`, resolved at runtime so the app whose id
is `<id>` reads the scoped values while every other app keeps the base value
(commit `510724328` shipped the first real consumer: per-app `captureUrlByDefault`).

But the settings UI (`plugins/config_v2/plugins/settings`) is **entirely
base-scoped**. The consequences, all called out in `config_v2/CLAUDE.md:85`:

- A descriptor's per-app values cannot be **inspected or edited** in-app — the
  only authoring path is hand-committing JSONC.
- Users have no way to **see which apps** a descriptor is customized for.
- A **stale scoped override** (a committed delta whose base origin moved after a
  runtime scoped edit) is honored on disk but never surfaced in a conflict
  banner — `computeAllConflicts` scans base paths only.
- There's no way to **create a new** per-app customization from the UI.

The good news from exploration: the **server/HTTP layer is already ~90%
scope-capable**. Every mutation endpoint (`set-field`, `reset-field`,
`acknowledge-conflict`, `delete-override`, `merge-conflict`, `raw-file`) and the
values + tiers resources already accept / are keyed by `scopeId`. The settings
UI simply never passes one. Two genuine backend gaps remain (conflicts resource
+ a per-descriptor fork primitive); the rest is wiring `scopeId` through the
settings web layer.

### Decisions (confirmed with user)

- **v1 = inspect + edit + reconcile + create.** Includes adding a brand-new
  per-app customization from a picker.
- **Switcher UX = segmented tabs** at the top of the detail pane (`Base` + one
  tab per customized app, a `+` to add, a conflict dot per tab).
- **Nav badges = detail-pane only for v1.** Left-nav row badge stays
  base-scoped; scoped conflicts surface inside the detail pane. Nav-level
  aggregation deferred to follow-up `task-1781289653065-1qk90p`.

---

## Design

### A. Backend — close the two gaps (`plugins/config_v2`)

**A1. Scope-key the conflicts resource.**
`computeAllConflicts` (`server/internal/resource.ts:122`) builds paths from
`join(CONFIG_DIR, dir, …)` with no scope segment. Change it to
`computeAllConflicts(scopeId?)` that builds paths via
`userScopedDir(dir, scopeId)` (already exists, `scope-paths.ts:23`) for the
origin/override/ancestor trio. Base callers pass nothing → identical behavior.

- Re-key both resource descriptors by `{ scopeId?: string }`:
  - core: `configV2ConflictsResource` (`core/internal/resource.ts:50`) → add the
    `{ scopeId?: string }` param type (mirrors `configV2TiersResource:59`).
  - server: `configV2ConflictsServerResource` (`server/internal/resource.ts:191`)
    → `defineResource<…, { scopeId?: string }>`, loader
    `({ scopeId }) => computeAllConflicts(scopeId)`.
- Fix the notify sites. `onFileChange` (`registry.ts:136`) currently calls
  `configV2ConflictsServerResource.notify()` — make it
  `notify(scopeId ? { scopeId } : {})` using the entry's `scopeId` (the watcher
  closure already knows it). Add a `notifyConflicts(scopeId)` helper alongside
  `notifyValues`/`notifyTiers` so a **base** change also re-notifies every
  un-forked known scope (they resolve base-live), exactly mirroring the existing
  `notifyValues` fan-out at `registry.ts:170`.

**A2. Per-descriptor scope enumeration resource** — "which apps is this
descriptor customized for?"

- New core resource `configV2ScopesResource` keyed by `{ path: string }`,
  schema `z.array(z.string())` (scopeIds) — add to `core/internal/resource.ts`.
- New server resource in `server/internal/resource.ts`: loader looks up the
  descriptor + `hierarchyPath`, returns
  `discoverScopeIds(hierarchyPath).filter(sid => scopeHasOwnConfig(descriptor, sid))`.
  `discoverScopeIds` (`scope-paths.ts:40`) already lists user-layer `@app/<id>`
  dirs (covers both propagated committed git scopes **and** runtime forks);
  `scopeHasOwnConfig` (`registry.ts:218`) confirms own-config. Export
  `scopeHasOwnConfig` for the loader (currently module-private).
- Notify it on fork/remove and on scoped file create/delete (see A3).

**A3. Per-descriptor fork primitive** — bootstrap a brand-new scope.
`setConfig(…, scopeId)` **throws** when no scoped origin/override exists
(`registry.ts:421`, deliberate). The existing `forkScope` (`scope-fork.ts:19`)
creates the scoped origin but is all-or-nothing over `scope:"app"` descriptors —
wrong granularity. Add **per-descriptor** variants:

- `forkDescriptorScope(storePath, scopeId)` — mirror one iteration of
  `forkScope`'s body for a single descriptor: snapshot `getConfig(descriptor,
  scopeId)` (= base-effective for an untracked scope, preserving any committed
  git delta), strip provider-backed (secret) fields, write the scoped
  `origin.jsonc` + `.jsonc` (same content+hash → zero conflict), then
  `ensureScopeEntry`. After this, the existing scoped `setConfig` path works for
  every subsequent edit. Notify `configV2ScopesResource` + conflicts/values/tiers.
- `removeDescriptorScope(storePath, scopeId)` — mirror one iteration of
  `deleteScope`'s body for a single descriptor: delete the scoped override; if
  git-backed (`gitBacksScope`, `scope-fork.ts:42`) keep the propagated origin and
  rebuild the entry (falls back to committed scope), else delete origin, dispose
  the entry, and rmdir the now-empty `@app/<id>` dir. This is "stop customizing
  this descriptor for this app" (distinct from `delete-override`, which only
  reverts edits to the scoped origin).

Editing **committed git scopes needs no fork** — their scoped origin is already
propagated, so `setConfig(…, scopeId)` reads it and writes a user override
directly. Fork is only for creating a scope where none exists.

**A4. New endpoints** (`core/internal/endpoints.ts`):
- `POST /api/config-v2/fork-descriptor-scope` body `{ storePath, scopeId }`
- `POST /api/config-v2/remove-descriptor-scope` body `{ storePath, scopeId }`

Implement in `server/internal/` next to `forkScope`/`deleteScope`'s handlers,
wrapping errors in `HttpError(400, …)` like `settings/server/internal/handlers.ts`.
(Note: the value/tiers/conflict/raw/reset/ack/merge endpoints already take
`scopeId` — no change there.)

### B. Settings web — thread `scopeId` through the detail pane

All files under `plugins/config_v2/plugins/settings/web/`.

**B1. Scope state in the detail pane.** `ConfigDetail` /`ConfigDetailInner`
/`ConfigDetailBody` (`components/config-detail.tsx`) gain a selected-scope state
(`undefined` = Base). Keep it as **local React state** in the pane (no new pane
route param needed — the user picks a tab after the descriptor opens). Reset to
Base on `registration.storePath` change (existing effect at line 89).

**B2. Scope tab bar.** New component `ScopeTabs` rendered at the top of
`ConfigDetailBody`:
- Reads the descriptor's customized scopes via the new
  `configV2ScopesResource` ({ path: storePath }).
- Resolves each `app:<id>` scopeId to a display label + icon from
  `Apps.App.useContributions()` (`@plugins/apps/web` — import is **boundary-legal**;
  `plugin.** -> plugin.**` is allowed and peers like `ui/theme-engine`,
  `tasks/task-draft-form` already import it). Extract raw id with
  `scopeAppId(scopeId)` (`core` export) and `apps.find(a => a.id === rawId)`;
  fall back to the raw id when no app matches.
- Renders a `Base` tab + one tab per scope, plus a `+` button. A **conflict dot**
  per tab: subscribe `configV2ConflictsResource({ scopeId })` per tab and flag if
  it has an entry for this `storePath` (N is small — only customized apps).
- Use the existing segmented/tab primitives —
  `primitives/toggle-chip.SegmentedControl` or `primitives/tabbed-view`; match
  whatever the codebase already uses for in-pane tab rows (check
  `primitives/segmented-progress-bar`/`toggle-chip` for the closest fit). Reuse
  `primitives/status-dot` for the conflict dot.

**B3. `+` Add-app picker.** A popover (`primitives/popover`) listing apps from
`Apps.App.useContributions()` **not already** in the scope list. Selecting one
calls the `fork-descriptor-scope` endpoint, then selects that new tab. Use
`useEndpointMutation` (consistent with the pane's other mutations).

**B4. Thread `scopeId` into every read + write** in `ConfigDetailBody`,
`ConfigFieldRow`, and `RawFileView`:
- Values: read `useResource(configV2Resource, { path: storePath, ...(scopeId && { scopeId }) })`
  inside the combined-resources gate (the body already gates on conflicts+tiers
  via `useCombinedResources` + `<Loading/>`, so values-via-resource adds no new
  flash). This avoids `useConfig`'s base-oriented gating heuristic
  (`forked || hasCommittedScope`), which wouldn't fire for a fresh
  per-descriptor scope. `useConfig` elsewhere stays unchanged.
- `useConflicts(scopeId)` (`internal/use-conflicts.ts`) → pass `{ scopeId }` to
  the resource.
- `useTiers(storePath, scopeId)` (`internal/use-tiers.ts`) → pass `{ path, scopeId }`.
- Conflict-banner buttons (`handleDismiss`/`handleAcceptAll`/`handleMerge`,
  config-detail.tsx:137-159) and the per-field `setField`/`resetField`/
  `handleAcceptOrigin` (config-field-row.tsx:73-86) → include `scopeId` in each
  body. Pass `scopeId` as a prop from `ConfigDetailBody` → `ConfigFieldRow`.
- `RawFileView` (config-detail.tsx:357) → pass `{ storePath, scopeId }` query to
  `getConfigRawFile`.
- On a non-Base tab, show a **"Stop customizing"** action (calls
  `remove-descriptor-scope`) next to "Reset all".

**B5. Empty/edge states.** When a scope is selected but the descriptor has no
own-config there yet (shouldn't happen post-fork, but defensively), the resource
returns base values — fine to display. Secret/provider fields stay redacted at
all scopes (server already redacts in `resolveRedactedConfig`).

### C. Docs

Update `config_v2/CLAUDE.md` — remove the "Not yet wired" caveat at line 85,
and add a short "Per-app scopes in settings" paragraph describing the scope tab
bar, add-app, edit, reconcile, and stop-customizing flows. `./equin build`
regenerates the autogen reference block + `docs/plugins-*.md`.

---

## Critical files

**Backend (`plugins/config_v2/`):**
- `server/internal/resource.ts` — `computeAllConflicts(scopeId?)`, scope-keyed
  conflicts resource, new `configV2ScopesResource` server loader, export
  `scopeHasOwnConfig`.
- `core/internal/resource.ts` — `configV2ConflictsResource` re-key, new
  `configV2ScopesResource` descriptor.
- `core/internal/endpoints.ts` — two new fork/remove endpoints.
- `server/internal/registry.ts` — `notifyConflicts` fan-out + scoped notify in
  `onFileChange`; export `scopeHasOwnConfig`.
- `server/internal/scope-fork.ts` — `forkDescriptorScope`,
  `removeDescriptorScope` (factor the per-descriptor body out of
  `forkScope`/`deleteScope` and have those call it in a loop to avoid duplication).
- server barrel `index.ts` + a handlers file — register the two endpoints.

**Settings web (`plugins/config_v2/plugins/settings/web/`):**
- `components/config-detail.tsx` — scope state, gate values via resource, thread
  `scopeId` everywhere, render `ScopeTabs`, "Stop customizing".
- `components/config-field-row.tsx` — accept + forward `scopeId`.
- `components/scope-tabs.tsx` *(new)* — tab bar + add-app picker + per-tab
  conflict dots.
- `internal/use-conflicts.ts`, `internal/use-tiers.ts` — accept `scopeId`.
- `core/internal/endpoints.ts` (settings) — only if the fork/remove endpoints
  live here instead of config_v2 core (prefer config_v2 core, next to
  `forkScope`/`deleteScope`, since they're scope primitives not settings-only).

**Reuse (no change):** `userScopedDir`, `discoverScopeIds`, `scopeHasOwnConfig`,
`gitBacksScope`, `ensureScopeEntry`, `getConfig`, all already-scope-capable
mutation handlers, `Apps.App.useContributions`, `scopeAppId`.

---

## Verification (end-to-end)

1. `./equin build`; app at `http://<worktree>.localhost:9000`.
2. **Inspect existing committed scope.** Open Settings → Config → the
   `tasks/task-draft-form` descriptor. Confirm a `Base` tab + an `Agent Manager`
   tab (the committed `@app/agent-manager` scope from `510724328`). Switch to it
   → `captureUrlByDefault` reads `off`; Base reads `on`.
3. **Edit a scoped value.** On the app tab, toggle a field; confirm the write
   lands at `~/.singularity/config/<wt>/tasks/task-draft-form/@app/agent-manager/config.jsonc`
   (inspect via `query_db`-style file check or the Raw file view), tier shows
   `user`, and Base is unaffected.
4. **Create a new scope.** Click `+`, pick an app with no customization → tab
   appears, fields editable, files created under that app's `@app/<id>` dir.
5. **Stop customizing.** Use "Stop customizing" on the new (non-git-backed) tab
   → tab disappears, files removed, app reverts to base.
6. **Scoped conflict.** Simulate a stale scoped override: edit the committed
   `config/<hier>/@app/<id>/config.jsonc` base origin hash (or change the base
   origin then rebuild) so the scoped override goes stale, rebuild, reopen the
   app tab → the warning banner appears with View diff / Merge / Accept / Keep,
   and the tab shows a conflict dot. Reconcile and confirm it clears.
7. `./equin check` — `type-check`, `plugin-boundaries`,
   `config-origins-in-sync`, `plugins-doc-in-sync` all green.
8. (Optional) Scoped unit coverage near `tier-logic`/`scope-paths` tests if
   present: `bun test plugins/config_v2/...`.
