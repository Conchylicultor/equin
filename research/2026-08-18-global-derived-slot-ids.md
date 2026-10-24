# Derived slot ids — the id comes from the owning plugin, not from a string literal

Status: design (read-only planning). Supersedes the "Derived slot ids" follow-up filed in
[`2026-08-17-global-source-parsing-vs-barrel-import-audit.md`](./2026-08-17-global-source-parsing-vs-barrel-import-audit.md)
(task `task-1786959985810-5htvbq`), whose Layers 1–2 landed in `2358be6cb` + `fa7e865e0`.

---

## Context

Every slot id is a hand-typed string chosen by convention, with nothing deriving or
enforcing it. `plugins/apps/plugins/studio/plugins/shell` (plugin id `apps.studio.shell`)
declares `studio.sidebar`; the `studio.` prefix is a human choice. Three costs follow.

**The id can disagree with its owner.** Only **11 of 212** reorderable slot ids currently
start with their owning plugin id. `apps-core` owns `apps.app`; `apps.workflows.shell` owns
`workflows-app.sidebar`; `tasks.launch-options` owns `tasks.launch-option`. Nothing notices.

**The id can be an arbitrary runtime expression.** That is what made factory slots
undiscoverable at build time, and it produced this comment at
`plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx:189`:

> The template is spelled out INLINE on purpose: the codegen scanner that builds the
> reorderable-slots manifest statically parses exactly `` defineRenderSlot(`${<first param>}.<static suffix>`, …) ``.
> Hoisting the id into a variable makes this slot invisible to it.

A load-bearing comment asking a human to preserve a syntactic shape. (The scanner it
protects — `reorderable-slots-scan.ts`, 736 lines with its test — has had **zero consumers**
since the declaration-based manifest landed. It is already dead.)

**The config path names the plugin twice.** A slot's config file is
`config/<asPath(pluginId)>/<slotId>.jsonc`, so
`config/apps/studio/compositions/closure-tree/studio.compositions.closure-tree.jsonc`
spells the hierarchy in the directory and then again in the basename.

Deriving the id from the owning plugin id plus a declaration key makes a computed id
unspellable, makes an id that disagrees with its owner unspellable, and makes the config
tree self-consistent.

### Why this was blocked, and why it no longer is

The filed task called out the migration: slot ids are config paths, and
`pruneOrphanedConfigFiles` deletes any config whose descriptor is not in the live set, so a
plain rebuild after an id change destroys authored overrides. Four findings shrink that:

1. **The directory never moves.** All 212 origins and all 112 authored overrides sit at
   exactly `config/<asPath(pluginId)>/<slotId>` — **0 mismatches**. Only the basename changes.
2. **No hash churn.** `@hash` is `computeHash(defaults)` over content only
   (`plugins/config_v2/core/internal/config-proxy.ts:13-28`, used at
   `config-origin-gen.ts:290`). `renderOriginJsonc` emits neither `descriptor.name` nor
   `hierarchyPath`. A sweep of all 212 slot ids across `config/` finds zero real occurrences.
   So a rename is byte-preserving and every existing `@hash` stays valid.
3. **Saved layouts are unaffected.** A reorder tree names contributions by
   `entryKey = ${pluginId}:${contributionId}` — the slot id is not in it.
4. **The destructive window is closable on its own** (C1 below), independently of any of this.

---

## The rule

A slot has no id of its own. Its id is `${owningPluginId}.${declarationKey}`, assigned by the
declaration pass. The constructor takes no id parameter, so there is nothing to spell.

```ts
// plugins/apps/plugins/studio/plugins/shell/web/slots.ts
export const Studio = {
  Sidebar: defineRenderSlot<SidebarItem>(),   // no id argument
  Toolbar: defineRenderSlot<ToolbarItem>(),
};

// plugins/apps/plugins/studio/plugins/shell/web/index.ts
export default {
  slots: Studio,                              // was: slots: [Studio]
  contributions: [ … ],
} satisfies PluginDefinition;
```

→ `apps.studio.shell.sidebar`, `apps.studio.shell.toolbar`, and the config files become
`config/apps/studio/shell/sidebar.jsonc` and `toolbar.jsonc`.

### Decisions taken

- **Scope: full derivation (C1–C6).** 201 of 212 ids change.
- **Declaration: group values allowed.** `slots` is a record whose value may be a slot or a
  slot-bearing object (a pane, a `definePaneToolbar()` result, a slot group), read exactly one
  level deep — the same depth `collectSlots` already uses. A group member contributes a second
  segment: `slots: { canvas: canvasPane }` → `apps.studio.graph.canvas.actions`. Most of the
  157 barrels declaring `slots: [Group]` become `slots: Group`, a one-character change; the
  ~110 entries that are panes or bare slots get a key (a codemod proposes it from the variable
  name — `storyDetailPane` → `storyDetail` — and a human reviews).
- **User layer: manual one-shot script.** `~/.singularity/config/<worktree>/` is host state no
  commit can carry; it is renamed once, by hand, at land time. No build machinery to add and
  later remove.

### Derivation details

- `seg(key)` kebab-cases: `TabBarActions` → `tab-bar-actions`, `JSONLViewer` → `jsonl-viewer`.
- Segments join with `.`. The **config descriptor name is the key path only** (`sidebar`,
  `story-detail.actions`) — the directory already carries the plugin. This is what makes the
  rename a pure in-place basename change.
- Asserted at declaration (rung 4, naming plugin + key): each segment matches
  `/^[a-z0-9]+(-[a-z0-9]+)*$/` (so a key cannot smuggle a `.` and re-spell hierarchy); no two
  keys collapse to one segment; no slot object appears under two keys; and **the key path is
  never `config`** — ~25 plugins already own a descriptor by that name.

---

## Why the runtime dispatch key must become the slot object

An id assigned at declaration cannot flow through `_slotId`, because a barrel's
`contributions: [Studio.Sidebar({…})]` is an **array literal evaluated at module eval**, before
any declaration pass. Two consumers settle it beyond doubt:
`plugins/framework/plugins/web-core/web/App.tsx:49,81` filters `c._slotId === Core.Boot.id` and
`=== "apps.app"` **before `PluginProvider` mounts at all**. No late-bound string can work there.
Object identity can.

So `Contribution` carries `_slot: SlotHandle` instead of `_slotId: string`, and `bySlot`
becomes `Map<SlotHandle, Contribution[]>`. The id string then exists **only** as a persistence
and documentation key, read after declaration. `slot.id` becomes a non-enumerable getter that
**throws** while undeclared — which converts every "read the id too early" bug into a loud
failure at the read, and is what catches `define-detail-sections.tsx:202` (`const slotId =
Section.id` at factory time) automatically.

`isSlot()` must drop its `typeof s.id === "string"` test and key on `meta` +
`useContributions`, so the object walks that look for slots never trip the throwing getter.

---

## Landing sequence

### C1 — `pruneOrphanedConfigFiles` never deletes an authored override

**The whole stated blocker, removed on its own, in ~30 lines.** Today
(`config-origin-gen.ts:407-437`) it `unlinkSync`s *any* `.jsonc` with no live descriptor and
only `console.warn`s afterwards. Change it to prune `*.origin.jsonc` and `*.ancestor.jsonc`
freely (both generated) and, for a hand-authored `.jsonc`, **throw** with the file list and a
one-line remedy. Removing or renaming a descriptor then fails the build until a human deletes
the override deliberately.

This matters more than it looks, because the build deletes *before* it checks —
`internal/app-artifacts.ts`: `regenerateManifestCodegen` → `seedAuthoredOverrides` →
`propagateConfigToUser` → **then** `runChecks`. With a half-applied rename, one
`./equin build` deletes all 112 overrides, re-seeds them at the new names in *natural
catalog order* with a `@review` marker, propagates that into the user layer, and only then runs
the checks that would have complained. The authored arrangement survives only in git's index.

Worse, `regen-generated` (`cli/bin/commands/regen-generated.ts:22-23`) runs the same codegen
from `./equin push` **and from `.githooks/post-rewrite` after any rebase or amend**,
followed by `git add -A && git commit --amend` — so a prune there is silently amended into the
landing commit. C1 is what makes that path safe.

Independent of everything below; land it first regardless.

### C2 — delete the dead scanner

`reorderable-slots-scan.ts` + `reorderable-slots-scan.test.ts` (736 lines, zero consumers),
`unresolvableCallIdMessage` if unused elsewhere, and the now-false "spelled out INLINE on
purpose" comment. Zero behaviour change.

### C3 — object-identity dispatch (ids still hand-authored)

- `plugins/framework/plugins/web-sdk/core/types.ts` — `Contribution._slotId: string` →
  `_slot: SlotHandle`.
- `plugins/framework/plugins/web-sdk/core/context.tsx` — `bySlot: Map<SlotHandle, …>`, keyed on
  `c._slot`.
- `plugins/framework/plugins/web-sdk/core/slots.ts` — the contribution closes over `slot`;
  `useContributions` does `ctx.bySlot.get(slot)`.
- `plugins/framework/plugins/web-sdk/core/sealed-component.ts:21` — same field swap.
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` — every
  `bySlot.get(id)` → `.get(slot)`; `renderIsolated`/`applyItemMiddlewares` take the handle and
  call `slot.id` only where a display string is genuinely needed.
- The seven hardcoded `_slotId === "<literal>"` sites become identity comparisons — the literal
  disappears entirely: `web-core/web/App.tsx:49,81`, `page/editor/check/index.ts:207,214,300,381`,
  `page/annotations/check/index.ts:109`, `config_v2/check/registrations-paired.ts:77`,
  `plugin-meta/facets/check/index.ts:77`, `codegen/core/token-group-vars-gen.ts:107`,
  `plugin-meta/facets/plugins/contributions/facet/index.ts:101`.
- **New `defineSlotFacade(fn, slot)`** in `slot-render/web`, for the three exported callables
  that copy `.id`/`.meta` at module eval and would otherwise bake nothing:
  `config_v2/plugins/fields/web/internal/slots.tsx:39`, `page/editor/web/slots.ts:181`, and
  `apps-core/web/slots.ts` (`Apps.App`, already patched once by `fa7e865e0` for this exact
  class). It forwards `meta`/`useContributions`/`Render`/`Dispatch`, defines `id` as a getter
  onto the target, and exposes `_slot` so identity checks resolve through it. There is then no
  id to copy.
- Free rung-2 upgrades in the same pass: `useReorderedEntries(slot)` (was a raw `slotId`
  string; one call site, `page/editor/web/components/block-type-list.tsx:35`),
  `useSlotHasContributions(slot: SlotHandle)` (`app-shell-layout.tsx:101`, which today accepts
  any `{ id: string }`).
- **Make "barrels imported" imply "slots declared"**: move the memoized
  `declareSlotsFromBarrels(root)` inside the barrel-import phase of `buildEnrichedTree`, so no
  build-time consumer can read a slot's id without a declaration pass having run.
  `registrations-paired.ts:56` already calls it by hand today; that call becomes redundant.

**Gate: `git status` must show no change under `config/` at all.**

### C4 — `slots` array → record (ids still hand-authored)

- `SlotRecord = Record<string, SlotHandle | SlotGroup>`; `collectSlots` returns the key path
  beside each slot; `declarePluginSlots` stamps `_pluginId` **and `_key`**.
- Add the segment/duplicate/never-`config` assertions.
- **Make `declarePluginSlots` throw on *any* duplicate id, including same-plugin.** Today
  (`declaration.ts:228-239`) it throws only when two *different* plugins claim an id. Two slots
  of one plugin colliding passes silently, and downstream they share one contribution list at
  render (wrong pane's actions), collapse to one manifest row, and — because only one descriptor
  registers — the other's authored override is deleted by the prune. This is the one failure mode
  that loses data silently; it must be a hard throw plus a `slots:derived-ids-unique` check so it
  fails at `./equin check`, not at first render.
- Because both ids are simultaneously knowable in this commit, `reorderable-slots-gen.ts` emits
  the rename table as committed data:
  `plugins/reorder/shared/slot-id-rename.generated.json` — `[{ hier, from, to }]`, `from =`
  today's `slot.id`, `to =` tomorrow's key path. It is exact (no join, no heuristic, no content
  matching), it is reviewable in the diff, and it is what lets the user-layer script run on a
  machine that skipped ten builds and lets the orphan audit say "renamed" rather than "removed".

**Gate: still zero renames, zero config churn. Eyeball the table: 212 rows, 201 with
`from !== to`, every `hier` an existing directory.**

### C5 — drop the `id` parameter (the atomic flip)

All six constructors lose their first argument:

```ts
defineSlot<P>(opts?)            defineRenderSlot<P>(config?)     defineMountSlot<P>(config?)
defineWrapperSlot<P>(config?)   defineDispatchSlot<…>(config)    defineOrderedDispatchSlot<…>(config)
```

~224 call sites change by deleting a leading string literal — a codemod over the same
`markerCallSpans` machinery `parseSlotCalls` already uses. Every slot-producing factory stops
composing an id and takes none: `Pane.define` (`pane.ts:2060`, the single biggest producer at
102 of 212), `definePaneToolbar`, `defineDetailSections`, `defineTabbedView`,
`defineVariantRegionWeb`, `defineItemActions`, `defineFieldExtensions`, `defineDataViewSources`.

`reorderDirectiveDescriptor` takes the **key path** as `descriptor.name`; the manifest row gains
`configName`. **Keep the descriptor name and the origin-catalog key derived from one place**:
the origin's content is `catalog.get(descriptor.name)` where the catalog is keyed off each
contribution's slot (`reorderable-slots-gen.ts:139-147, 238-241`). If those two ever resolve
differently, the lookup misses, `renderOriginJsonc` silently falls back to `{ items: [] }`,
**every hash changes and all 112 overrides get re-marked** — and `seedWhen` then also skips
seeding, so the prune-then-reseed path leaves nothing. One derivation, used by both sides.

The `config/` renames land **in this same commit** (see below).

### C6 — cleanup

Rewrite the slots facet's barrel-free path onto the record keys plus the plugin's own path —
**the entire id set becomes statically computable with no barrel import and no template-literal
parsing**, which is what finally makes the two discovery mechanisms agree by construction rather
than by audit. Delete `namesFromBarrelExports` and `parseSlotCalls`' id reading. Add
`config-v2:names-unique-per-plugin` (short names make a slot key and a plain `defineConfig` name
newly collidable in one directory; 30 hierarchies host both). Update `config/CLAUDE.md` and
`plugins/reorder/authoring-overrides.md`, which both document the path as
`config/<defining-plugin>/<slotId>.jsonc`. Delete the rename table and the script once main has
built.

---

## The config migration (inside C5)

Plain committed `git mv`s in the same commit as the code change — **not** a build step, which
would be racy against the `regen-generated` + `--amend` path and buys nothing. Because content
and hash are unchanged, the moves are *sufficient*: `generateConfigOrigins` rewrites
byte-identical bytes at the new paths, the prune finds nothing orphaned, every `@hash` still
matches, and `seedAuthoredOverrides` seeds nothing.

312 renames: 212 origins + 112 overrides (100 slots have no authored override). Origins are
moved too, even though they regenerate, so the diff reads as renames rather than 212 deletes +
212 adds.

**Assert before moving anything (this is the dry run):**

1. Build the old→new map from the live declaration pass; **fail on any duplicate target**,
   same-plugin or cross-plugin. Print it.
2. It is a bijection over exactly the 212 current ids.
3. Every target path is free, and `<to>` collides with no existing descriptor name in that
   `<hier>` (the 30 shared directories; never `config`).
4. Every source `config/<hier>/<from>.origin.jsonc` exists (212); record which have an override (112).
5. `<hier>` is unchanged for every entry — anything that moves directories stops the run for
   hand review.

**Verify after:** `sha256` identical for all 312 moved files; `git diff --find-renames --summary`
shows **312 pure renames and zero content changes** under `config/`; then a full
`./equin build` produces an **empty** diff under `config/` — no re-render, no prune line,
no `@review` marker minted. That last one is the end-to-end proof that the derivation and the
filenames agree.

**Land it right after `git fetch origin main && git rebase origin/main`.** `.gitattributes`
gives `config/**/*.origin.jsonc` the `merge=regen-generated` driver but **overrides get no
driver**, so every hour the branch sits open is another chance for a rename/modify conflict on a
hand-authored file beside an auto-resolved origin.

### The user layer, by hand

`~/.singularity/config/<worktree>/` is never pruned, so nothing is destroyed — but every
override lands under the old name, becomes an orphan, and the slot silently reverts to the
committed default. Across 136 worktree dirs that is ~29k propagated origins plus **8 genuine
user overrides per worktree** (`apps.app`, `conversation.action-bar`, `conversation.header`,
`prompt-editor.floating-action`, `action-bar.item`, `shell.sidebar`, `shell.toolbar`,
`task-detail.section`) — the user's own in-app drags.

`plugins/config_v2/scripts/rename-slot-configs.ts` gets a `--user` mode driven by the same
committed table, applying the identical `(hier, from → to)` renames to `.jsonc`,
`.origin.jsonc`, `.ancestor.jsonc` and their `@app/*` variants. It only ever **moves**, never
deletes, and is idempotent (`!src && dst` → already migrated; `src && dst` → throw). Run once,
by hand, at land time. Fallback if skipped is benign: orphans surface in Debug → Config Orphans.

---

## Also rekeyed (accept, and say so in the commit message)

- **Detail-section open state** — `define-detail-sections.tsx:248` persists
  `` `${slotId}.${section.id}.open` `` in localStorage. Every detail section resets to its
  default on every device. Same shape for `defineTabbedView` → `useActiveViewId` and the
  view-switcher key.
- **Render-loop report fingerprints** — `culprit-signature.ts:125` builds `${pluginId}@${slotId}`
  from the `data-slot-id` DOM marker, persisted in the report payload. Open reports rebucket once.
- **183 `.md` files** mention at least one of the 212 ids; every id appears in at least one.
  Autogen blocks and `docs/plugins-*.md` are regenerated and covered by `plugins-doc-in-sync`;
  hand-written prose goes stale silently and is not worth chasing exhaustively.

---

## Verification

Per commit, and never `./equin push`:

- **C1** — delete a `defineConfig` temporarily; the build must stop and name the override
  instead of deleting it. `./equin check config-origins-in-sync`.
- **C3** — `./equin test plugins/framework/plugins/web-core` (the `_slotId` assertion at
  `plugin-render.test.tsx:21` becomes `_slot`); `./equin check`; `./equin build`;
  **clean `git status` under `config/`**.
- **C4** — as C3, plus the rename-table review.
- **C5** — the real gate:
  1. `./equin check` clean, specifically `reorderable-slots-in-sync`,
     `config-origins-in-sync`, `config:overrides-authored` (**zero** new `@review` markers — a
     wave of 112 is the loudest possible symptom of a mis-keyed rename),
     `config-v2:registrations-paired` (the correct canary for web/server derivation skew),
     `plugins-doc-in-sync`, `plugin-boundaries`, `type-check`.
     Note `config-origins-in-sync` returns on its **first** failure, so use
     `reorderable-slots-in-sync` — which prints every path it thinks is owed — as the dry-run
     oracle instead of iterating it 112 times.
  2. `git status` under `config/`: renames only, **zero `D` on any non-`.origin.jsonc`**.
  3. `./equin test plugins/framework/plugins/slot-declaration` — new unit tests for
     `seg()`, key→segment collision, a slot under two keys, a slot declared by two plugins, a
     same-plugin duplicate, one-level group nesting, a pane, `config` as a key, and the throwing
     getter on an undeclared slot.
  4. `./equin build` (background, per the root rules), then at
     `http://<worktree>.localhost:9000`: enter reorder edit mode on **a sidebar** (a direct slot)
     and **a pane's action bar** (a group member), drag, reload, confirm the order persists. That
     exercises slot object → descriptor reference identity → config name → file on disk, which no
     check sees end to end.
  5. Break it once on purpose: drop an entry from a `slots` record and confirm the build names
     the orphan; add a second key pointing at the same slot and confirm the duplicate throw.
- **C6** — `./equin check`, plus a `skipBarrelImport` docgen run whose barrel-free slot set
  must match the barrel-imported one exactly.

---

## Critical files

- `plugins/framework/plugins/slot-declaration/core/declaration.ts`
- `plugins/framework/plugins/web-sdk/core/{slots.ts,context.tsx,types.ts,sealed-component.ts}`
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`
- `plugins/framework/plugins/tooling/plugins/codegen/core/{config-origin-gen.ts,regen-pipeline.ts,reorderable-slots-gen.ts,slot-declaration-guard.ts}`
- `plugins/reorder/shared/directive.ts`, `plugins/reorder/{web,server}/internal/config-registrations.ts`
- `plugins/primitives/plugins/pane/web/pane.ts` (102 of the 212 slots)
- `plugins/config_v2/server/internal/orphan-audit.ts`
