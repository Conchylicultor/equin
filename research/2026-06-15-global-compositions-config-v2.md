# Move composition manifests out of code → config_v2 (runtime-editable)

## Context

A **composition manifest** (`{ name, entryPoints, selectedContributors }`, owned by
[`closure`](../plugins/plugin-meta/plugins/closure/core/types.ts)) is a named selection of
plugin entry-points + opted-in soft contributors that the Studio closure
visualization resolves and tints. Today manifests are **TS barrels** at
`<plugin>/composition/index.ts`, discovered by build-time collected-dir codegen
(`composition.generated.ts`) and loaded via `loadCompositions()`. Creating or
editing one therefore requires a `./equin build` — the wrong shape for the
Studio compositions pane, which can only hold **in-memory drafts** that are
never persisted ("Draft — not saved to repo" banner).

This migrates manifests to **plain editable data in `config_v2`**: a runtime
read/write JSONC config with no codegen. config_v2 is the right primitive — it
already models a `listField` of structured records, reactive client reads
(`useConfig`), runtime writes (`useSetConfig` / `setConfig`), per-worktree
storage, *and* a built-in git-layer (committed default) / user-layer (runtime
override) tiering. The Studio draft editor gains real Save / New / Delete that
write the config; all read paths swap from the generated registry to the config.

### Decisions (confirmed with user)

- **Array fields** (`entryPoints`, `selectedContributors`, both `PluginId[]`):
  complete the already-planned **`string-list` field-type migration**
  ([research/2026-06-09-…-string-list.md](./2026-06-09-global-fields-migration-batch-4-string-list.md)),
  and **upgrade its renderer to individual-element drag-and-drop** (not the old
  textarea).
- **Save scope**: runtime save into the per-worktree config only. **Git-promotion
  is a filed follow-up** — and that follow-up is the bigger idea: generalize the
  reorder-specific staging machinery into a config_v2-level promotion driven by
  the existing `promotableToGit` flag, so *any* config can be promoted to a
  committed default. Compositions becomes its second consumer.

---

## Design

```
                       ┌─ engine consumers (membership/graph/inclusion) ─ CompositionManifest[]
config_v2 (manifests)  │
  listField:           ├─ Studio compositions pane ── list/edit/save ─ config items (with id/rank)
   { name,             │
     entryPoints,      └─ composition-closure check ─ git-layer disk read → CompositionManifest[]
     selectedContributors }

GET /api/composition/data  →  now returns ONLY { graph, allIds }   (code-derived; stays server-side)
manifests                  →  read from config_v2, merged client-side
```

The plugin tree **graph + allIds** are code-derived structure and stay on the
`GET /api/composition/data` endpoint. Only **manifests** — user data — move to
config. The composition `web` barrel keeps owning the manifest read/write API so
consumers never touch `config_v2` directly (collection-consumer separation).

### 1. Complete the `string-list` field migration + drag-and-drop renderer

Execute the existing plan
[2026-06-09-…-string-list.md](./2026-06-09-global-fields-migration-batch-4-string-list.md)
to recreate `plugins/fields/plugins/string-list/` (type core + identity) and
`plugins/fields/plugins/string-list/plugins/config/` (factory `stringListField` +
renderer), and re-point the one importer (`plugins/reorder/shared/directive.ts`).

**Deviation from that plan**: replace the moved-byte-for-byte textarea renderer
with a **sortable list of individual string rows** — each row a text input + drag
handle + remove button, plus an "Add" affordance — composing the
[`sortable-list`](../plugins/primitives/sortable-list) primitive (`SortableList` /
`SortableItem`). Value stays `string[]`; ordering follows row order.
- This upgrades the renderer for **all** `string-list` consumers, including the
  reorder `order`/`hidden` directives shown in Settings — a deliberate repo-wide
  UX improvement (flag in the change summary).

### 2. Define + register the compositions config

New `plugins/plugin-meta/plugins/composition/core/config.ts` (core, not shared —
the build-time check must import it; `defineConfig` + field factories are all
core-safe):

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";

export const compositionsConfig = defineConfig({
  name: "compositions",
  promotableToGit: true,                 // enables the future git-promotion follow-up
  fields: {
    manifests: listField({
      label: "Compositions",
      itemFields: {
        name: textField({ label: "Name" }),
        entryPoints: stringListField({ label: "Entry points" }),
        selectedContributors: stringListField({ label: "Contributors" }),
      },
      default: [ /* the two agent-manager seeds, below */ ],
    }),
  },
});
```

- **Seed** `default` with the current `agent-manager` + `agent-manager-lean`
  manifests (migrate the literal ids from
  `apps/plugins/agent-manager/composition/index.ts`). Give each seed an
  **explicit stable `id` + `rank`** (list `id`/`rank` are only auto-injected by
  the UI "Add"; code defaults must carry their own so seeded rows are editable
  and ordered). Use the [`rank`](../plugins/primitives/rank) primitive for the two
  rank strings.
- Re-export `compositionsConfig` from `core/index.ts`.
- `composition/web/index.ts`: add `ConfigV2.WebRegister({ descriptor: compositionsConfig })`.
- `composition/server/index.ts`: add `ConfigV2.Register({ descriptor: compositionsConfig })`.

### 3. Manifest read/write API in `composition/web` (single owner)

Add to `composition/web` (keeps `config_v2` encapsulated):
- `useManifestItems()` → raw config items `{ id, rank, name, entryPoints, selectedContributors }[]`
  via `useConfig(compositionsConfig)` — for the compositions pane list + editing.
- `saveManifest(item, editingId?)` / `deleteManifest(id)` → `useSetConfig(...)("manifests", next)`
  (upsert by `id`; append with fresh `id`+`rank` when `editingId` is null).
- `useCompositionData()` (`web/internal/hooks.ts`): keep returning
  `{ graph, allIds, manifests }`, but source `manifests` from `useManifestItems()`
  **mapped to `CompositionManifest[]`** (drop `id`/`rank`) instead of from the
  endpoint response. Engine consumers (`useActiveMembership`, graph pane,
  `useInclusion`/`useImpact`) keep their `CompositionManifest` shape — **untouched**.

Add a pure mapper in `core` (e.g. `manifestItemToManifest`) reused by the server
handler, the check, and the web layer.

### 4. Swap the two server/build read paths off the codegen registry

- **Server handler** `server/internal/data-handler.ts`: replace
  `loadCompositions()` with `getConfig(compositionsConfig).manifests` (server
  runtime is up, reads the **user layer** = live edits) → map to
  `CompositionManifest[]`. Return only `{ graph, allIds }` from the endpoint;
  drop `manifests` from `CompositionData` / `compositionDataSchema`
  (`core/endpoints.ts`).
- **Check** `framework/tooling/.../composition-closure/check/index.ts`: it runs
  with **no server runtime**, so `getConfig` is unavailable. Read the **git
  layer** off disk via the existing core `readTypedConfig(descriptor, origin,
  overrides)` (precedent: the `config-origins-in-sync` check reads `config/*.jsonc`
  directly). Construct paths from `git rev-parse --show-toplevel`:
  `config/plugin-meta/composition/compositions{.origin,}.jsonc` (exact hierarchy
  path is config_v2-derived from the plugin id). Map items → `CompositionManifest[]`,
  then run the existing closure validation unchanged.
  - **Clean read primitive**: add `fileConfigProxy(path)` to `config_v2/core`
    (pure `readFileSync` + jsonc parse + `// @hash` strip — generalizes the
    server-private `jsoncConfigProxy`). The check pairs it with `readTypedConfig`;
    avoids duplicating JSONC-read logic. (`jsoncConfigProxy` can later delegate to it.)

### 5. Wire the Studio draft editor to persist

In `apps/plugins/studio/plugins/compositions/web`:
- Replace the **"Draft — not saved to repo"** banner with real actions:
  **Save** (calls `saveManifest(draft, editingId)`), **New composition**
  (fresh draft, `editingId = null`), **Delete** (`deleteManifest(id)`).
- The compositions pane tracks `editingId | null` local state alongside the
  existing in-memory draft store (`setActiveComposition` / `updateActiveDraft`
  stay as the editing buffer; Save flushes the buffer to config). The list comes
  from `useManifestItems()`.
- After a write, `useConfig` pushes the new value over the live-state socket →
  list + tints update reactively (no manual invalidation).

### 6. Delete the codegen / barrel path

- Delete `apps/plugins/agent-manager/composition/index.ts` (seed now lives in the
  config default) and the now-empty `composition/` dir.
- Delete `composition/core/collected-dir.ts`, `composition/core/composition.generated.ts`,
  `composition/core/load-compositions.ts`, `composition/core/is-composition.ts`
  (if only used by the loader), and drop their exports from `core/index.ts`
  (`compositionCollectedDir`, `loadCompositions`, `isCompositionManifest`).
- The codegen stops emitting `composition.generated.ts` once
  `defineCollectedDir("composition")` is gone; `plugins-registry-in-sync` then
  requires the committed generated file be removed (it is).
- Update `composition/core/load-compositions.test.ts` → test config-default
  seeding + the item→manifest mapper (drop the generated-registry discovery test).

---

## Files

**Create**
- `plugins/fields/plugins/string-list/**` + `…/plugins/config/**` (per the 2026-06-09 plan; renderer = drag-and-drop)
- `plugins/plugin-meta/plugins/composition/core/config.ts`
- `plugins/config_v2/core/internal/file-config-proxy.ts` (+ export from `config_v2/core`)

**Modify**
- `plugins/plugin-meta/plugins/composition/core/index.ts` (export config + mapper; drop loader exports)
- `plugins/plugin-meta/plugins/composition/core/endpoints.ts` (drop `manifests` from payload)
- `plugins/plugin-meta/plugins/composition/server/index.ts` (Register) + `server/internal/data-handler.ts` (getConfig)
- `plugins/plugin-meta/plugins/composition/web/index.ts` (WebRegister + export read/write API) + `web/internal/hooks.ts` (manifests from config)
- `plugins/apps/plugins/studio/plugins/compositions/web/**` (Save/New/Delete; list from config)
- `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts` (disk read)
- `plugins/reorder/shared/directive.ts` (string-list import path)
- `plugins/plugin-meta/plugins/composition/CLAUDE.md`, `…/composition/core/load-compositions.test.ts`

**Delete**
- `plugins/apps/plugins/agent-manager/composition/index.ts`
- `plugins/plugin-meta/plugins/composition/core/{collected-dir,composition.generated,load-compositions,is-composition}.ts`
- `plugins/config_v2/plugins/fields/plugins/string-list/**` (old location, per 2026-06-09 plan)

---

## Behavior changes / caveats

- **Check now validates the committed (git-layer) manifests.** Runtime-only
  manifests a user creates in their worktree live in the user layer and are
  **not** closure-checked until promoted to git (the follow-up). This is
  consistent — the check gates commits, and uncommitted drafts shouldn't block
  them — but it's a real tiering change from "every barrel is checked".
- **One-time build prerequisite for writes.** config_v2 runtime writes require the
  `.origin.jsonc` propagated by `./equin build` (it runs once from the
  seeded `default`). After that, all runtime edits work with no further build.
- **`string-list` renderer change is repo-wide**: reorder directive configs in
  Settings switch from textarea to drag-and-drop rows.
- **Identity**: seeded `default` items must carry explicit `id`+`rank`; the
  closure check still enforces unique `name`.

## Follow-ups (file via `add_task`)

1. **Generalize git-promotion to any `promotableToGit` config.** Lift the
   stage/apply/discard endpoints, the review-pane section, and the atomic
   git-layer writer job out of `reorder/plugins/staging` into a config_v2-level
   primitive keyed on the `promotableToGit` flag; make reorder **and**
   compositions consumers. This is the direct answer to "can all config fields be
   generalized to this?" — yes, and it's the clean home for it.
2. (Optional) Hide the raw `compositions` config from the generic Settings list
   if surfacing it there is noisy (Studio is the intended editor).

## Verification

1. `bun install` (new workspace packages) → `./equin build` → `./equin check`
   all pass (`plugin-boundaries`, `plugins-registry-in-sync` with the generated
   file gone, `composition-closure` reading git-layer config, `config-origins-in-sync`,
   `eslint`, `type-check`).
2. `bun test plugins/plugin-meta/plugins/composition/core/load-compositions.test.ts`
   (seeding + mapper).
3. App at `http://<wt>.localhost:9000` → Studio → Compositions: the two seeded
   manifests list; select one, toggle a contributor / entry point, **Save** →
   reload the pane and confirm it persisted; **New** → create + save a third;
   **Delete** it. Confirm the Explorer/graph tint updates live on every edit.
   Inspect `~/.singularity/config/<wt>/plugin-meta/composition/compositions.jsonc`
   to confirm the write landed.
4. Settings → a reorder directive (string-list consumer): confirm the new
   drag-and-drop renderer reorders/persists.
