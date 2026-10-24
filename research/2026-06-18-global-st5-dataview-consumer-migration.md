# ST5 — DataView consumer migration + default-fallback verification

> Sub-task **ST5** of the unified view-switcher roadmap
> ([`research/2026-06-15-global-unified-view-switcher.md`](./2026-06-15-global-unified-view-switcher.md)).
> Status: **plan**. Depends on ST1–ST4 (landed).

## Context

ST1–ST4 turned `data-view` into a config-driven **named-instance** surface: a
consumer that registers `viewsDescriptor(storageKey)` (web + server) gets
Notion-style named view instances (`Cards / All / …`) authored in a per-`storageKey`
`views` config_v2 list, with an editable switcher (add/rename/duplicate/delete/
reorder) and durable sort/filter written back to each instance's config row.
Consumers that **don't** register fall back to the pre-config behavior: one
synthesized instance per registered view-type, sort/filter in localStorage.

ST5 closes the loop: prove the migration didn't silently break any existing
`<DataView>` consumer running on the **default-instances fallback** (no committed
config), and bless a committed **reference instance set** on the one config-mode
consumer (`sonata/library`) that exercises the new model end-to-end.

**Scope decisions (confirmed with user):**
- **Opt-in, manifest deferred.** Only `sonata/library` registers a descriptor and
  carries a `views.origin.jsonc`. The other consumers stay pure default-fallback —
  no registration, no origin. The build-time manifest that would make *every*
  consumer config-upgradable without a code change (roadmap gotcha #99) is **not**
  built here; it lands when the resolver is extracted to `primitives/plugins/views/`
  (ST6). Documented as future work, not silently skipped.
- **Enrich the reference set** to exercise same-type-twice + a saved filter + a
  config-authored gallery option (not just the current minimal 2 instances).

## Current state (verified)

- **9 `<DataView>` consumers exist, not 4** — the roadmap doc is stale. Only
  `sonata/library` (`storageKey="sonata:library"`, `views={["gallery","table"]}`)
  is multi-view and config-mode. The other 8 are single-view, default-fallback:
  `deploy/servers`, `story/shell`, `conversations/agents`, `pages/page-tree`,
  `tasks/task-list/tree`, `config_v2/settings`, `ui/tweakcn/community-browser`,
  `home/app-cards`.
- **`sonata/library` is fully wired and committed, worktree clean:**
  `config/apps/sonata/library/views.jsonc` (2 instances: `Cards`/gallery,
  `All`/table+sort) and `views.origin.jsonc` (`{"views":[]}`), both `// @hash 1befa300d09b`.
  The origin defaults are `{views:[]}` → the hash is **stable**; an override's
  `@hash` tracks the *origin* content, so editing the override never changes the hash.
- **Default-fallback + config-mode branch logic exists** and is a stable per-mount
  split (`DataView` → `useConfigRegistrations()` ref-identity check →
  `ConfigDataView`/`DefaultDataView`).

## The one structural gap (the real ST5 fix)

**Config mode drops the consumer's code-supplied `viewOptions`.**
`buildInstanceFromRow` (`web/internal/resolve-instances.ts:77`) sets the instance's
`options` to the serialized config row `row.view` alone — it never merges
`viewOptions[type]`. Default mode keeps them (`options: viewOptions?.[type]`,
`resolve-instances.ts:60`).

Consequence: `sonata/library` passes
`viewOptions={{ gallery: { renderCard: SongCard, cover, … } }}`. Those are
**non-serializable code options** (React component fns) that can never live in a
config row. In config mode the gallery instance's `options` is just
`{ type: "gallery" }`, so `gallery-view.tsx` (reads `options.renderCard`,
`options.cover`, `options.minCardWidth`, `options.coverField` —
`gallery-view.tsx:106,158,171,145,152`) silently falls back to the **default card**.
This is precisely the ST5 risk ("a consumer silently breaking when config is
present") and the fix is structural, not a one-off.

**Fix:** layer the config-authored options **on top of** the consumer's code
options, so non-serializable code options survive and config-authored keys
(`sort`/`filter`/`coverField`/`minCardWidth`) override:

```ts
// resolve-instances.ts — buildInstanceFromRow gains viewOptions and merges:
options: { ...(viewOptions?.[row.view.type] as object ?? {}), ...(row.view as object) }
```

Thread `viewOptions` from `useConfigViewModel` (`use-view-model.ts:123`, already in
scope) → `useViewsConfig` (new param) → the `instances` memo's
`buildInstanceFromRow` call (`use-views-config.ts:178`). Default mode is unaffected
(it already passes `viewOptions[type]`). This is the layering that makes the
enriched reference set's gallery option meaningful while keeping `SongCard`.

## Plan

### Step 1 — Fix config-mode option composition *(core)*
- `plugins/primitives/plugins/data-view/web/internal/resolve-instances.ts`: add an
  optional `viewOptions?: Record<string, unknown>` param to `buildInstanceFromRow`;
  set `options` to `{ ...(viewOptions?.[row.view.type] ?? {}), ...(row.view) }`.
- `plugins/primitives/plugins/data-view/web/internal/use-views-config.ts`: add a
  `viewOptions` param to `useViewsConfig`; pass it into `buildInstanceFromRow` in the
  `instances` memo (line ~178). Keep it in the memo deps.
- `plugins/primitives/plugins/data-view/web/internal/use-view-model.ts`: pass
  `viewOptions` from `useConfigViewModel` into `useViewsConfig`.

### Step 2 — Enrich the `sonata/library` reference set *(core)*
Author the enriched set via the **in-app round-trip** (the authoring loop that also
verifies write-back), then transcribe into the committed override:
1. Open `sonata/library`, use the editable switcher to: keep `Cards` (gallery) but
   give it a config-authored option (e.g. `minCardWidth`) via its options sub-form;
   keep `All` (table, sorted); **duplicate** `All` → rename `By composer`, apply a
   **filter** (e.g. composer text contains …) + a different sort via the filter/sort
   UI. This proves same-type-twice + saved filter + options sub-form.
2. The debounced write-back persists to the user-global layer file under
   `~/.singularity/config/<wt>/apps/sonata/library/views.jsonc`. Read it, copy the
   resulting `views` array (exact `operatorId`/`fieldId` tokens, `FilterGroup`
   shape) into the committed `config/apps/sonata/library/views.jsonc`.
   - Keep `// @hash 1befa300d09b` unchanged (origin is still `{views:[]}`).
   - Row shape is `{ id, rank, name, view: { type, sort?, filter?, …typeOpts } }`;
     `sort` = `{ fieldId, direction }`, `filter` = a `FilterGroup`
     (`{ kind:"group", id, conjunction, children:[{kind:"rule",…}] }`), gallery
     option = `coverField`/`minCardWidth` directly under `view`.
3. Reload and confirm the committed set renders, the gallery still uses `SongCard`
   (Step 1 fix), the filtered table filters, and the active-id stays device-local.

### Step 3 — Default-fallback verification matrix *(verification; fix on break)*
Build, then drive each of the 8 non-registered consumers with scripted Playwright
(`e2e/screenshot.mjs`) confirming: renders without console errors, correct single
view, no editable-switcher chrome (no add/rename), localStorage sort still works.
If any breaks, fix structurally in the resolver/host (not at the call site — the
DataView API is unchanged and must stay backward-compatible).

| storageKey | surface to load |
|---|---|
| `deploy:servers` | deploy app servers list |
| `story:gallery` | story app gallery |
| `agents-list` | agent-manager (tree) |
| `pages-sidebar` | pages app sidebar (tree) |
| `tasks-list` | tasks app (tree) |
| `config_v2.settings.nav` | settings → config nav (tree) |
| `tweakcn.community-browser` | appearance → community themes (gallery, embedded) |
| `home:apps` | home launcher (gallery) |

### Step 4 — Reconcile the roadmap doc
In `research/2026-06-15-global-unified-view-switcher.md`: correct "4 consumers" → the
actual 9 (list them, flag `sonata/library` as the only config-mode one); note in ST5
that the build-time manifest is **deferred to ST6** with the opt-in rationale; mark
ST5's verification line satisfied.

### Step 5 — Checks green
`./equin build` then `./equin check` — specifically
`config-origins-in-sync` (sonata origin/override hashes match), `type-check`,
`plugins-doc-in-sync` (data-view barrel/CLAUDE.md autogen block if signatures
changed), `migrations-in-sync`, `eslint`.

## Critical files

- **Fix:** `plugins/primitives/plugins/data-view/web/internal/resolve-instances.ts`,
  `.../web/internal/use-views-config.ts`, `.../web/internal/use-view-model.ts`
- **Reference set:** `config/apps/sonata/library/views.jsonc`
- **Doc:** `research/2026-06-15-global-unified-view-switcher.md`
- **Read-only references:** the 9 consumer call sites (esp.
  `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx`),
  `.../plugins/gallery/web/components/gallery-view.tsx`,
  `plugins/.../checks/plugins/config-origins-in-sync/check/index.ts`

## Verification

1. `./equin build` succeeds; `http://<worktree>.localhost:9000` boots.
2. **sonata config-mode:** the enriched `views.jsonc` renders its named instances;
   gallery card is `SongCard` (proves Step 1); the `By composer` table applies its
   committed filter+sort; switching active view is device-local; an in-app
   sort/filter edit write-backs to the instance's config row and survives reload.
3. **Default-fallback (all 8):** each renders unchanged, single view, no editable
   switcher, no console errors (scripted Playwright per Step 3).
4. `./equin check` green — `config-origins-in-sync`, `type-check`,
   `plugins-doc-in-sync`, `migrations-in-sync`, `eslint`.
5. `git status` shows only intended files; `config/apps/sonata/library/views.jsonc`
   keeps `// @hash 1befa300d09b`.

## Out of scope / follow-ups

- **Build-time consumer manifest + auto-registration** (every consumer gets an
  origin, config-upgradable with no code change) — deferred to ST6 extraction.
- ST6 (`primitives/plugins/views/` extraction), ST7 (tasks migration), ST8
  (tabbed-view slim/retire).
