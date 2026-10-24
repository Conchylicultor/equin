# Studio Compositions → list pane + `comp/:id` detail pane with render-slot sections

## Context

`/studio/compositions` is confusing, and the confusion is structural, not cosmetic.

Today `compositions-view.tsx` is one 548-line file that crams three unrelated things into a
single 380px column: a Draft/Compare `SegmentedControl`, the compositions list, **and** the
draft editors for whichever composition is selected. Selecting a row then auto-pushes
`explorerPane` to the right (`ensureExplorerBeside`) — so the thing that *looks* like the
composition's detail view is actually the generic plugin browser.

**Why that reads as wrong:** the Explorer is an independent plugin browser that predates
compositions — sidebar entry → full plugin tree → click a plugin → `pluginViewPane`. Six
sub-plugins contribute row badges; `explorer/membership` is merely one of them, painting a
tint off the active-composition store via `Explorer.TreeRowAccent`. The `graph` pane tints
itself the same way off the same store. Compositions borrowed the Explorer as its
visualization *because the tint happened to live there* — casting a peer browse surface as
its detail pane. That is the category error to undo.

**Outcome:** clicking a composition opens a real `comp/:id` detail pane whose content is a
`CompositionDetail.Section` render slot filled by sub-plugins — mirroring the `release`
plugin next door. The tinted tree becomes one *section* among several. Compare becomes its
own pane. Release stops being a separate sidebar app and folds into the composition it
releases (deleting a duplicate composition picker in the process). The URL — not a
`useState` — becomes the selection.

### Target shape

```
compositions (list pane, 380)                    [Studio.Sidebar entry]
├── comp/:id  (detail — CompositionDetail.Host, collapsible sections)
│     ├── draft-actions · membership-summary · contributors · entry-points
│     ├── closure-tree      (tinted PluginTree)
│     ├── release           (target picker + Run)
│     └── release-history   (this composition's runs)
│           └── rel/:runId  (run detail — info · logs · artifact)
└── compare (A/B pickers + DiffDelta)
```

### Decisions (settled with the user)

| # | Decision |
|---|---|
| 1 | Compare → its own pane. The Draft/Compare `SegmentedControl` is deleted. |
| 2 | The tinted closure tree is a **section**, not a pane. `ensureExplorerBeside` + the `explorerPane` import are deleted. `explorer/membership` is untouched and still tints the standalone Explorer. |
| 3 | Release UI moves under compositions; the `Studio.Sidebar` "Release" entry + `releasePane` are removed. `@plugins/release/core` (the engine) is untouched. |
| 4 | One sub-plugin per section. |
| 5 | Release history: client-filter the existing windowed resource, surface the window in the UI, file a follow-up. |
| 6 | `defineDetailSections(..., { collapsible: true, defaultOpen: true })`. |
| 7 | "New" creates the config row immediately → opens `comp/:id`. `editingId`/`effectiveEditingId` are deleted. |
| 8 | Add `stableIdentity: true` to the `manifests` list field. |

## Verified facts

- **`c/:id` is TAKEN** — `plugins/conversations/core/routes.ts:3` owns `c/:convId`, and
  `normalizeSegmentPattern` (`primitives/pane/core/route.ts:115-124`) erases param *names*,
  so `c/:id` collides. Enforced at runtime (`pane.ts:1702-1706`) and by the
  `pane:segments-unique` check. **`comp/:id` and `compare` are free** (dumped all 91
  segments). `p/:id` appears only in `route.test.ts`, which the check excludes.
- **`PluginTree` owns `defineDataView("studio.explorer.tree")`**
  (`explorer/web/components/plugin-tree.tsx:19`, `storageKey={EXPLORER_VIEW}` at `:187`).
  Reusing it as-is would make the closure-tree section **share view/filter/sort config with
  the Explorer pane** — filtering one silently filters the other. Fixed below via an
  optional `storageKey` prop.
- **`save(draft, editingId?): void`** (`composition/web/internal/manifests.ts:28`) mints
  `crypto.randomUUID()` internally at `:64` and returns nothing — so Decision 7 cannot learn
  the new id to navigate to. Must be widened to return the id.
- **`config/apps/studio/shell/studio.sidebar.jsonc` lists `"apps.studio.release:release"`** —
  a stale entry once the sidebar contribution is removed.
- Config path is derived from the plugin's dotted id: `config/<asPath(pluginId)>/<id>.jsonc`.
  Moving a plugin silently orphans its old committed `.jsonc` and **loses the authored
  views** — no check catches that. (`config-origins-in-sync` *does* flag orphaned
  `.origin.jsonc` and blocks push.) A plugin move therefore **requires** `git mv`-ing config.
- **The compositions plugin itself does not move** → `config/apps/studio/compositions/studio.compositions.jsonc`
  stays put. Only `release` moves beneath it.
- `defineDataView` id strings must **not** change — changing one orphans its authored views.
- `ReleaseRun` carries `composition: string` (the name), so client-side filtering is a plain
  `.filter()`. `releaseHistoryResource` is keyed on `id`, full-recompute, **windowed to the
  50 most-recent runs per worktree**.

> **Caveat found during planning — `stableIdentity: true` is currently a no-op here.**
> `config-stable-list-ids` resolves each `config/**/<name>.jsonc` to its descriptor by
> rewriting to `<name>.origin.jsonc`; an origin file rewrites to `*.origin.origin.jsonc`,
> finds nothing, and is skipped. Only *override* files are checked — and
> `config/plugin-meta/composition/compositions.jsonc` doesn't exist (only the origin is
> committed). The flag becomes load-bearing the moment someone commits a git-layer override
> (which `usePromoteManifestsToGit` produces). Still worth setting — it also flips the list
> field to explicit-id-only at runtime — but do not claim it enforces anything today.

## File tree

### `plugins/apps/plugins/studio/plugins/compositions/` (id unchanged)

```
compositions/
  CLAUDE.md                                  REWRITE (the "opens the tinted Explorer as a
                                                     sibling Miller column" + Draft/Compare
                                                     narrative is now false)
  web/
    index.ts                                 REWRITE
    slots.ts                                 NEW
    panes.tsx                                REWRITE
    internal/use-seed-active-composition.ts  NEW
    components/
      compositions-list.tsx                  NEW (extracted)
      compare-view.tsx                       NEW (extracted)
      compositions-view.tsx                  DELETE (548 lines redistributed)
      diff-delta.tsx                         unchanged (now only compare-view)
      composition-item-actions.tsx           unchanged
      membership-summary.tsx  → git mv → plugins/membership-summary/web/components/
      contributor-editor.tsx  → git mv → plugins/contributors/web/components/
      entry-editor.tsx        → git mv → plugins/entry-points/web/components/
  plugins/
    draft-actions/       { package.json, CLAUDE.md, web/index.ts, web/components/draft-actions.tsx }
    membership-summary/  { …, web/components/{membership-summary-section,membership-summary}.tsx }
    contributors/        { …, web/components/{contributors-section,contributor-editor}.tsx }
    entry-points/        { …, web/components/{entry-points-section,entry-editor}.tsx }
    closure-tree/        { …, web/components/closure-tree-section.tsx }
    release/             ← git mv (below)
```

Package names are path-derived: `@singularity/plugin-apps-studio-compositions-<name>`.

### `git mv studio/plugins/release` → `studio/plugins/compositions/plugins/release`

New id `apps.studio.compositions.release`.

```
compositions/plugins/release/
  CLAUDE.md         REWRITE
  web/
    index.ts        REWRITE (no Studio.Sidebar, no releasePane; 2 CompositionDetail.Section
                             + Pane.Register(releaseDetailPane); still exports ReleaseDetail)
    slots.ts        unchanged
    panes.tsx       REWRITE (releasePane DELETED; releaseDetailPane survives,
                             defaultAncestors → [compositionDetailPane])
    components/
      release-section.tsx          NEW  (TargetPicker + Run — the composition Select is GONE)
      release-history-section.tsx  NEW  (the DataView, client-filtered)
      release-launcher.tsx         DELETE (split into the two above)
  plugins/{release-info,release-logs,release-artifact}/   ← moved; only package.json `name`
                                                            + the one import path change
```

## Key implementation details

### The seeding effect — `internal/use-seed-active-composition.ts`

This is the crux and the single most likely place to introduce a bug.

```ts
/**
 * Drive the module-level active-composition store from the URL. Seeds the store with the
 * manifest named by the pane's `:id` param, exactly ONCE per id.
 *
 * The `seededFor` ref — not the dep array — is the guard. `item` is a fresh object on every
 * `manifests` config write, so an `[item]`-keyed effect would re-fire after each save() and
 * CLOBBER the in-progress draft `updateActiveDraft` is building. `item` is still read (not
 * just `id`) because config may not have settled on a deep link's first paint; the ref is
 * stamped only once a real item exists.
 *
 * There is deliberately NO cleanup. clearActive() on unmount would be a correctness bug:
 * Studio sidebar nav uses mode:"root", which unmounts this pane, and explorer/membership's
 * tint reads useActiveComposition() from this same store. Pick a composition here, then go
 * look at the Explorer — the store MUST outlive the pane. clearActive stays a user action.
 */
export function useSeedActiveComposition(id: string): void {
  const items = useManifestItems();
  const item = items.find((it) => it.id === id);
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (!item || seededFor.current === id) return;
    seededFor.current = id;
    setActiveComposition(structuredClone(manifestItemToManifest(item)));
    setCompareComposition(null);
  }, [id, item]);
}
```

Accepted consequences: `save` does not reseed (the draft survives the write — correct);
`comp/A → comp/B → comp/A` reseeds A from config, discarding unsaved A edits (the URL owns
*which*, the store owns *the draft of the current one*).

### Panes — `web/panes.tsx`

```ts
export const compositionsPane = Pane.define({
  id: "compositions", segment: "compositions", component: CompositionsBody, width: 380,
});

function useResolveComposition({ id }: { id: string }) {   // mirrors task-detail's useResolveTask
  const items = useManifestItems();
  const { isLoading } = useCompositionData();
  if (isLoading && items.length === 0) return { pending: true, found: false };
  return { pending: false, found: items.some((it) => it.id === id) };
}

export const compositionDetailPane = Pane.define({
  id: "composition-detail",
  defaultAncestors: [compositionsPane],
  segment: "comp/:id",          // VERIFIED free — `c/:id` is conversations'
  component: CompositionDetailBody,
  width: 560,                   // wider than release-detail's 480: it hosts the plugin tree
  resolve: useResolveComposition,
  useTitle: ({ id }) => useManifestItems().find((it) => it.id === id)?.name,
});

export const comparePane = Pane.define({
  id: "composition-compare", defaultAncestors: [compositionsPane],
  segment: "compare",           // VERIFIED free; paramless → no resolve
  component: CompareBody, width: 480,
});
```

Use a real `resolve` hook (task-detail's shape), **not** release's `resolve: false` — a deep
link to a deleted id must get the Not-Found chrome, not a blank pane.

### `web/slots.ts`

```ts
export const CompositionDetail = defineDetailSections<{ id: string }>(
  "composition-detail", { collapsible: true, defaultOpen: true },
);
```

### Sections

Each is `({ id }: { id: string }) => ReactElement`; preamble `useActiveComposition()`, plus
`useManifestItems().find(i => i.id === id)` where the stored row is needed. Render a muted
caption when `draft` is null (one frame before the seed lands).

| Sub-plugin | Section | Notes |
|---|---|---|
| `draft-actions` | `{id:"draft-actions", label:"Draft"}` | Name `Input` + Save + Delete + Clear from `compositions-view.tsx:62-102`. `save(draft, id)` — id is the pane param, **always present**; the null-id branch dies. Delete → `remove(id); clearActive(); close()` via `compositionDetailPane.useClose() ?? (() => openPane(compositionsPane, {}, {mode:"root"}))`. |
| `membership-summary` | `{id:"membership-summary", label:"Summary"}` | `useActiveMembership()`; renders `<MembershipSummary/>` verbatim. |
| `contributors` | `{id:"contributors", label:"Contributors"}` | Owns its own `useState("")` query (hoisted to the parent today only because the editor was a child — a strict simplification). `resolved` memo moves verbatim from `compositions-view.tsx:160-165`. |
| `entry-points` | `{id:"entry-points", label:"Entry points"}` | `allIds` from `useCompositionData()`. |
| `closure-tree` | `{id:"closure-tree", label:"Closure"}` | `useEndpoint(getPluginTree, {})` → `<PluginTree storageKey={CLOSURE_TREE_VIEW} …/>`, `onSelect` → `openPane(pluginViewPane, {pluginId}, {mode:"push", side:"right"})`. Tint is free (PluginTree renders `Explorer.TreeRowAccent`). Wrap in a bounded `Scroll` (`max-h-[60vh]`) or the tree dwarfs every sibling section. |
| `release` | `{id:"release", label:"Release"}` | `TargetPicker` verbatim (`release-launcher.tsx:71-97`) + Run. **The composition `Select` is deleted**; `composition` = the row's `name`. Today's Select filtered to `category === "app"` — any composition is now reachable, so disable Run with a caption when `category !== "app"` rather than allowing a nonsense release. |
| `release-history` | `{id:"release-history", label:"Release history"}` | `runs.filter(r => r.composition === name)`; fields from `release-launcher.tsx:206-287` **minus the `composition` column** (constant now — promote `target` to `primary`). `storageKey` stays `defineDataView("studio.release.history")`. Ship the window caveat as a muted caption: *"Showing this composition's runs from the 50 most recent overall."* |

### `PluginTree` gets an optional `storageKey`

Sharing `studio.explorer.tree` between the Explorer pane and the closure-tree section would
mean filtering one filters the other — the same class of surprise this whole change exists
to remove. Add an optional prop defaulting to today's value (additive, no caller churn):

```ts
// explorer/web/components/plugin-tree.tsx
export function PluginTree({ storageKey = EXPLORER_VIEW, … }) { … }
```

The closure-tree section declares its own marker **in its own `web/**`** (codegen attributes
`defineDataView` to the *defining* plugin, which fixes the config path):

```ts
// compositions/plugins/closure-tree/web/components/closure-tree-section.tsx
const CLOSURE_TREE_VIEW = defineDataView("studio.compositions.closure-tree");
// → config/apps/studio/compositions/closure-tree/studio.compositions.closure-tree.jsonc
```

And export the component from the explorer barrel, beside `explorerPane`:

```ts
// Exported so sibling Studio surfaces (the compositions closure-tree section) can render the
// tinted tree inline. Standalone: {plugins, selected, onSelect, storageKey?} — no pane
// coupling. Explorer never imports compositions → DAG-safe.
export { PluginTree } from "./components/plugin-tree";
```

### List pane

`compositions-list.tsx` = `CompositionsDataView` (`compositions-view.tsx:377-470`, verbatim —
`defineDataView("studio.compositions")` id **unchanged**) plus a header action row:

```
[New] [Compare]                        [Set as default for everyone]
```

**Both stay in the list pane's body header, not `PaneChrome`'s header:** it's where they live
today (a pure lift, no `pane-toolbar` factory needed); "Set as default for everyone" is far
too long for a 380px header bar; and both are *list-scoped* (promote acts on the whole set,
New creates into it), so they belong to the list surface, not the pane chrome.

- `selectedRowId` = `compositionDetailPane.useRouteEntry()?.params.id` — **the URL is the
  selection**; `editingId` is deleted.
- `onRowActivate` → `openPane(compositionDetailPane, {id: item.id}, {mode:"push", side:"right"})`.
- **New** → `const newId = save({name:"Untitled composition", entryPoints:[], selectedContributors:[]});`
  then open `comp/:newId`. Requires widening `save` to return the id (below).
- **Compare** → `openPane(comparePane, {}, {mode:"push", side:"right"})`. Both are pushed from
  the same caller, so pushing one truncates the other — Compare and Detail are mutually
  exclusive **by construction**, which is right: both drive the single `active` store slot.

`compare-view.tsx` = `CompareSection` + `CompositionPicker` (`:474-548`) with `Mode`,
`SegmentedControl`, `enterCompare`/`leaveCompare` deleted; `DEFAULT_A`/`DEFAULT_B` move here
and seed once in `CompareBody` via a `useRef` guard (same store-outlives-pane rule — no
`setCompareComposition(null)` on unmount; the next `comp/:id` seed clears it).

### Store changes (`plugin-meta/composition`) — small, additive, outside "studio UI only"

1. `core/config.ts:34` — add `stableIdentity: true` to the `manifests` `listField`.
2. `web/internal/manifests.ts:28,64` — widen `save(draft, editingId?): string` to return the
   item id (hoist `const newId = crypto.randomUUID()`; `return editingId ?? newId`). It
   already computes the id; returning it is additive, breaks no caller, and keeps id-minting
   where `Rank` lives. Required by Decision 7. **Call this out in review** — it's the one
   edit outside the studio UI.

### Import-cycle audit — DAG holds

```
compositions/plugins/release/plugins/*/web → compositions/plugins/release/web
compositions/plugins/release/web           → compositions/web (CompositionDetail), release/core,
                                             plugin-meta/composition/web
compositions/plugins/{draft-actions,membership-summary,contributors,
                      entry-points,closure-tree}/web → compositions/web
compositions/plugins/closure-tree/web      → explorer/web (PluginTree)          ← new
compositions/web                           → explorer/membership/web (DIFF_LEGEND) ← pre-existing
explorer/membership/web                    → explorer/web
```

Topological order, no back-edges: `shell`/`plugin-meta` < `explorer/web` < `explorer/membership/web`
< `compositions/web` < `compositions/plugins/*/web` < `release/plugins/*/web`. **Acyclic.**

- `compositions/web → explorer/*` is safe: explorer imports the *store*, never `compositions/web`.
  This restructure **strengthens** that — deleting `ensureExplorerBeside` removes the runtime
  coupling, leaving only a component import.
- `release/web → compositions/web` is a child importing its parent — identical to the existing
  `explorer/membership → explorer/web`. Parents never import children (the slot registry wires
  them at boot).
- **No cross-plugin re-exports**: `compositions/web` exports only its own `./slots` + `./panes`.
  It must **not** re-export `PluginTree`, `Explorer`, `DIFF_LEGEND`, or `ReleaseDetail`;
  `ReleaseDetail` stays exported from its owner and the three release sections import it there.

## Steps

1. **Store prep** — `stableIdentity: true`; widen `save` to return the id. Keep
   `bun test plugins/plugin-meta/plugins/composition/core/config.test.ts` green.
2. **`git mv` release + its config** — a *pure move*, reviewable as a rename:
   ```bash
   git mv plugins/apps/plugins/studio/plugins/release \
          plugins/apps/plugins/studio/plugins/compositions/plugins/release
   mkdir -p config/apps/studio/compositions/release
   git mv config/apps/studio/release/* config/apps/studio/compositions/release/
   rmdir config/apps/studio/release
   ```
   Then 4× `package.json` `name`, 3× import path, `bun install`. No component edits yet.
3. **Explorer barrel** — `storageKey` prop + export `PluginTree`.
4. **Compositions core** — `slots.ts`, `panes.tsx`, `internal/use-seed-active-composition.ts`,
   `compositions-list.tsx`, `compare-view.tsx`; delete `compositions-view.tsx`; rewrite `index.ts`.
5. **The five sub-plugins** — create each; `git mv` the three editor files into their new homes.
6. **Release rewrite** — split `release-launcher.tsx` into the two sections; rewrite `panes.tsx`
   + `index.ts`.
7. **CHECKPOINT — `./equin build`, then reconcile config by hand.** Do not proceed with a
   red tree. The build regenerates the registries, docs, `reorderable-slots.generated.ts`
   (path-keyed), `data-views.generated.ts`, and every `*.origin.jsonc`; the committed
   **overrides** are hand-authored and go stale:
   - `config/apps/studio/shell/studio.sidebar.jsonc` — drop `"apps.studio.release:release"`
     **and** update `// @hash` (currently `76c4ba22f264`; removing a registered item changes
     the origin → `config-origins-in-sync` blocks push until reconciled).
   - `config/apps/studio/compositions/release/release-detail.section.jsonc` — all three keys
     stale (`apps.studio.release.release-info:info` → `apps.studio.compositions.release.release-info:info`)
     + `@hash`.
   - `config/apps/studio/compositions/composition-detail.section.jsonc` — **new**; author in
     reading order (the generated origin sorts alphabetically):
     `draft-actions, membership-summary, contributors, entry-points, closure-tree, release:release, release:release-history`.
   - `config/apps/studio/compositions/release/studio.release.history.jsonc` — content is
     `{"views":[…]}`, hash unchanged; the `git mv` is the whole fix. Confirm nothing orphaned
     at the old path.

   Then `./equin check`. Expected gates: `plugins-registry-in-sync`, `plugins-doc-in-sync`,
   `plugins-have-claudemd`, `reorderable-slots-in-sync`, `data-views-in-sync`,
   `config-origins-in-sync`, `pane:segments-unique`, `config-stable-list-ids`, `composition-closure`.
8. **Runtime verification** (below).
9. **`add_task`** — per-composition release-history server query.
10. **CLAUDE.md rewrites** — `compositions/`, `compositions/plugins/release/`, `studio/`, plus one
    per new sub-plugin. Hand-write only the prose above the autogen fence.

## Verification

`./equin build`, then drive the real app at `http://att-1784281276-m7nu.localhost:9000/studio/compositions`
(scripted Playwright via `e2e/screenshot.mjs`, not blind screenshots):

- **New** → lands on `/studio/compositions/comp/<uuid>`, row selected, sections render.
- **Edit contributors → Save → the draft must NOT reset.** This is the §seeding clobber guard;
  if the seed is mis-keyed the chips snap back on save. *The single most likely bug in this change.*
- **Reload on `comp/<uuid>`** → deep link rehydrates. **Bogus id** → Not-Found chrome (proves
  `resolve` fires).
- **Detail open → sidebar → Explorer → the tree is still tinted.** Proves no `clearActive` on
  unmount — the regression Decision 2 exists to prevent.
- **Filter the Explorer tree → reopen a composition → the closure section is unfiltered.**
  Proves the separate `storageKey`.
- **Compare** from the list → the detail column is replaced, not stacked.
- **Release** → Run → history row appears → click → `rel/:runId` pushes with info/logs/artifact.
- **Delete** → row gone, pane closed, back on the list.
- No `Studio.Sidebar` "Release" entry remains.

## Follow-ups

- **Per-composition release-history server query.** The section client-filters the 50-row
  windowed `releaseHistoryResource`, so an old run for composition X vanishes once 50 newer
  runs exist for anything. (`add_task` in step 9.)
- **`config-stable-list-ids` skips `*.origin.jsonc`** (rewrites to `*.origin.origin.jsonc`,
  finds no descriptor, skips) — so it only checks committed *overrides*. Worth surfacing
  separately: the check is weaker than its name suggests.
