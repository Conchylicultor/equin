# Slots declare themselves: replacing the export-graph walk with an explicit, guarded declaration

## Context

An audit of how the repo recovers build-time knowledge about plugins found two
mechanisms running side by side with no rule for which applies when: static text
scanning (`plugin-meta/plugins/parse-utils/core`, ~30 consumers) and barrel
import (`plugin-meta/plugins/barrel-import`, ~10 consumers).

The prompting symptom was that **no pane's Actions bar is reorderable**.
`pane.ts:2003` mints `` defineSlot(`pane.${id}.actions`) `` — deliberately a plain
slot, with a comment saying a render slot is impossible because build-time codegen
cannot extract a templated id.

The audit's conclusion is narrower than "pick one mechanism":

> Text is forced for **type-level** and **provenance** facts. Everywhere else,
> the current inability to import is a symptom worth fixing at the source.

Two facts are genuinely erased at runtime and can only come from text:
**type exports** (`barrel-import/CLAUDE.md` documents `Exports (types): AutoStubEntry`,
an `export interface` that does not exist in the emitted JS — 559 such facts in
`docs/plugins-details.md`) and **import provenance** (a re-exported symbol and a
directly-imported one are the same object at runtime, so the boundary rules and
`no-reexport-default` can only be answered from source).

Everything else that "can't be imported" today is self-inflicted:

- `defineOrderedDispatchSlot` (`render-slot.tsx:579-591`) is
  `defineDispatchSlot(...) as unknown as ...`. Its own doc comment says the
  runtime is *literally* the same and the slot "enters the manifest via its own
  codegen marker" — a semantic property whose only carrier is the spelling of a
  function name in source text.
- `defineRenderSlot` computes `config?.reorder ?? true` and drops it into a
  closure, so the walk hardcodes `reorder: true`.
- Discovery is a recursive crawl of each barrel's export object graph
  (`slots/facet/index.ts:105`), so coverage depends on authoring style rather
  than on what the plugin actually owns.

This plan fixes those three at the source. It changes **no slot id and no config
path**; id derivation is deferred (see Follow-ups).

## The blind spots, on one real file

`plugins/apps/plugins/story/plugins/shell/web/index.ts` exhibits both at once:

- Line 17 is `export { StoryToolbar } from "./toolbar";`. The runtime walk finds
  `StoryToolbar.Start`/`.End` **only** because of that re-export. Delete it and
  the slots silently disappear from discovery while the app keeps working.
- Line 34 is `Pane.Register({ pane: storyDetailPane })` — inside the
  `contributions` **array**, and `isWalkableObject` (`slots/facet/index.ts:93`)
  skips arrays. A pane registered the normal way is structurally invisible.

The static scanner misses the same two panes for an unrelated reason (they are
`defineSlot`, with a templated id). Nothing reports either gap, because
`reorderable-slots-in-sync` diffs the committed manifest against the same scanner
that produced it.

## Can we guarantee a slot is declared? Yes.

This is the load-bearing question for the whole design, and the answer is
structural rather than conventional.

**Every slot constructor funnels through one function.** `defineSlot`
(`web-sdk/core/slots.ts:15`) is called by `defineRenderSlot` (`:143`),
`defineMountSlot` (`:308`), `defineWrapperSlot` (`:398`) and `defineDispatchSlot`
(`:465`); `defineOrderedDispatchSlot` wraps dispatch. So one line in `defineSlot`
captures **every slot that has ever been created**, with no registry to keep in
sync and nothing for an author to remember.

The guard is then a set difference:

- **Created** — appended by `defineSlot` at construction.
- **Declared** — the union of every loaded plugin's `slots: [...]`.
- `created \ declared` is non-empty ⇒ **build error**, naming each orphan id and
  the plugin directory whose source constructed it.
- The same pass builds `declared` as a Map, so **two plugins declaring the same
  id is also an error** — closing today's silent "first definer wins" dedupe.

Note what this buys beyond catching a forgotten entry: it makes the *ergonomic*
part safe. `collectSlots` only needs to normalise **one shallow level** (a slot
is itself; an object yields its slot-like own values, so `Studio`, `StoryToolbar`
and a pane all work). Anything nested deeper is not silently lost — it is
reported as an orphan and the author names it explicitly. The shortcut cannot
degrade into a blind spot.

**Where it runs.** The authoritative gate is **build time**, in the codegen
process, which imports every barrel and therefore sees complete sets. It must
*not* be the sole gate at browser boot: web plugins load in tiers
(`web-sdk/core/load-tiers.ts`), so `created` and `declared` are both partial
mid-boot and a slot created by an eager module but declared by a deferred plugin
would false-positive. A dev-only assertion after the last tier settles is a
reasonable backstop; the build check is the guarantee.

## Layer 1 — slots describe themselves

`web-sdk/core/slots.ts` and `slot-render/web/internal/render-slot.tsx`.

```ts
export interface SlotMeta {
  kind: "slot" | "render" | "mount" | "wrap" | "dispatch" | "ordered-dispatch";
  /** render + ordered-dispatch, honouring `config.reorder`; false otherwise. */
  reorderable: boolean;
}
```

Each constructor stamps `slot.meta` at creation. `defineOrderedDispatchSlot` stops
being a name only a grep can see; the `reorder: false` flag stops being trapped in
a closure. `runtimeKindHints` (`slots/facet/index.ts:79-86`) deletes its
duck-typing (`typeof s.Render === "function"`) and reads the field.

~10 LOC plus the deletion. Nothing downstream changes yet — this is the
precondition for Layer 2 being able to classify what it collects.

## Layer 2 — the plugin declares its slots

**Authoring.** `PluginDefinition` (`web-sdk/core/types.ts:55`) gains the exact
sibling of `contributions`:

```ts
slots?: SlotSource[];   // a slot, or an object whose own values are slots
```

The story shell becomes:

```ts
slots: [StoryToolbar, storyDetailPane, storyGalleryPane],
```

This fits the barrel-purity rule (a value in the default export, like
`contributions`) and is the "mirror working precedent" shape.

**Ownership** comes free and correct. `PluginProvider` (`context.tsx:44-58`)
already stamps `_pluginId: p.id` onto each contribution while iterating one
plugin's definition. The slot pass sits beside it and does the same. That is what
removes the "first importer, not owner" hazard named in
`research/2026-06-13-global-unify-slot-discovery-walk.md` — ownership no longer
depends on module-cache order, because it is read off the declaring plugin.

Slot objects are module-level and shared, so ownership is stamped on the object
rather than on a copy (unlike contributions, which are copied — identity matters
here because the reorder middleware looks up descriptors by reference). The
duplicate-declaration check is what makes that mutation safe: exactly one plugin
may claim a slot, so the stamp can never be contested.

**Discovery** switches to the declaration. `collectRuntimeSlots`
(`slots/facet/index.ts:105-142`) — the recursive walk, its `WeakSet` cycle guard,
its array skip and its `isSlotLike` sniffing — is deleted and replaced by reading
`p.slots`. The re-export at `story/shell/web/index.ts:17` stops being
load-bearing, and the panes become visible for the first time.

**The pane fix** then falls out: flip `defineSlot` → `defineRenderSlot` at
`pane.ts:2003` and delete the now-false comment at `:1999-2002`.
`PaneActionContribution` (`pane.ts:263`) already carries the required `id: string`,
so the contribution shape is unchanged. No id is parsed, because nothing parses.

## Ordering: the pre-barrel cycle

Layer 2 derives the manifest by importing, which collides with the rule that a
manifest imported by a barrel at module load must be written *before* the first
barrel import (`pre-barrel-manifests.ts:23-48` — Bun's ESM cache freezes a module
on first `import()`).

Resolution, in two parts:

1. **The web side stops needing the manifest.** With Layer 1's `meta`, each
   reorderable slot mints its own config descriptor at construction and stashes it
   on the slot object. `reorder/web/internal/descriptors.ts` — which today maps
   over `reorderableSlots` at module load (`:14`, `:23`, `:31`) — reads the
   descriptor off the slot instead. Reference identity, which the middleware
   depends on, is preserved trivially by there being exactly one object.
   `reorderPluginIdForSlot` reads the stamped owner.
2. **The server side keeps a generated list**, because the server runtime cannot
   see web-defined slots. It is no longer a *cycle*, only a sequence:
   `buildPluginTree` already imports in runtime order — `for (const runtime of
   ["web", "server", "central"])` (`plugin-tree.ts:353`) — so the manifest is
   written between the web and server phases. No web barrel reads it, so nothing
   is frozen stale.

`reorderableSlots` therefore leaves the `preBarrelManifests` list. The other four
entries stay exactly as they are.

## What the text scanner keeps doing

It is not deleted, and it is not a fallback. It moves from *discovering* slots to
*auditing* them, which is the job it is uniquely good at: text knows **where a
slot was declared and by whom**; the runtime knows **what it is**. Each covers the
other's blind spot, and the disagreement is the error surface.

Concretely, `reorderable-slots-scan.ts` keeps finding `define*Slot` call sites and
attributing them to the owning directory, and the build fails when a call site's
plugin has not declared a matching slot. That is the same set difference as the
orphan guard, computed from the other side — it catches the case where a slot is
constructed lazily or in a module no plugin's `slots` array reaches.

**Loudness, while these files are open.** The scanner silently drops ids it
cannot resolve (`reorderable-slots-scan.ts:240`, `:252`, `:261`, via
`leadingStringLiteral` at `:52-55` returning `string | undefined`). The correct
primitive already exists and is unused here: `parse-utils/core/helpers.ts` returns
discriminated `{ value } | { absent } | { dynamic, expr }` unions
(`readStringLiteral` at `:202`, `parseStringField` at `:293-307`). Switch to it and
throw on `dynamic`, naming file + `lineAt(src, call.index)` + expression. There
are **zero genuine offenders today**, so no allowlist or escape hatch is needed —
the 8 raw hits are 2 constructor declarations (`render-slot.tsx:139`, `:579`) and
6 factory-internal calls that `collectFactoryProducers` already visits, both
mechanically exemptable. Same treatment for `data-views-gen.ts`, which has the
identical silent-drop shape and an incidental `[^"]+` vs `[^"]*` mismatch that
makes `defineDataView("")` behave differently between the two scanners.

## Critical files

| File | Change |
|---|---|
| `framework/plugins/web-sdk/core/slots.ts` | `SlotMeta`; stamp `meta`; append to the created-set in `defineSlot` |
| `primitives/plugins/slot-render/web/internal/render-slot.tsx` | stamp `meta` in render/mount/wrap/dispatch/ordered-dispatch; mint + stash the reorder descriptor |
| `framework/plugins/web-sdk/core/types.ts` | `slots?: SlotSource[]` on `PluginDefinition` |
| `framework/plugins/web-sdk/core/context.tsx` | declare/collect pass beside the `_pluginId` stamp (`:44-58`); duplicate detection |
| `plugin-meta/plugins/facets/plugins/slots/facet/index.ts` | delete `collectRuntimeSlots` recursion + `runtimeKindHints` duck-typing; read `p.slots` |
| `primitives/plugins/pane/web/pane.ts` | `defineSlot` → `defineRenderSlot` at `:2003`; delete `:1999-2002` |
| `reorder/web/internal/descriptors.ts` | read descriptors off slot objects instead of the manifest |
| `codegen/core/reorderable-slots-gen.ts` + `pre-barrel-manifests.ts` | manifest written between the web and server import phases; drop `reorderableSlots` from the pre-barrel list |
| `codegen/core/reorderable-slots-scan.ts`, `data-views-gen.ts` | loud on unresolvable ids; scanner becomes the audit side of the guard |
| every plugin barrel that owns slots | add `slots: [...]` — the orphan guard names each one that needs it |

Reuse, do not reinvent: `parse-utils/core/helpers.ts` discriminated readers;
`lineAt` (`find-marker-calls.ts:144`); the `_pluginId` stamping pattern
(`context.tsx:56`); `collectFactoryProducers` (`reorderable-slots-scan.ts:100-166`)
for the exemption spans.

## Verification

1. **Byte-identity gate.** `plugins/reorder/shared/reorderable-slots.generated.ts`
   must be unchanged except for the added `pane.*.actions` rows. No existing id
   moves, so no `config/**.jsonc` path moves. Confirm `git status` shows no
   deletions under `config/` after a rebuild — `pruneOrphanedConfigFiles`
   (`config-origin-gen.ts:426-433`) `unlinkSync`s anything not in the live set, so
   a clean `config/` is the regression test for correct ownership.
2. **The guard fires.** Temporarily drop one entry from a `slots: [...]` array and
   confirm the build fails naming that slot id. Temporarily declare one slot in
   two plugins and confirm the duplicate error.
3. **The blind spots are closed.** Delete `export { StoryToolbar } from "./toolbar";`
   (`story/shell/web/index.ts:17`) and confirm `story.toolbar.start` is still
   discovered — today it silently vanishes.
4. **Panes appear.** After rebuild, `config/apps/story/shell/` gains
   `pane.story-detail.actions.jsonc` and `pane.story-gallery.actions.jsonc`, and
   the manifest gains one row per `Pane.define`.
5. `./equin check` — `reorderable-slots-in-sync`, `data-views-in-sync`,
   `plugins-doc-in-sync`, `plugin-boundaries`, `type-check`. A renderer throw must
   surface as `{ ok: false, message }`, not an unhandled crash in the check runner.
6. `./equin test plugins/plugin-meta/plugins/facets` plus a focused test for
   the created-vs-declared difference: orphan, duplicate, one-level group,
   factory result, pane.
7. End to end: `./equin build`, then enter reorder edit mode on a pane's
   action bar at `http://<worktree>.localhost:9000` and confirm the actions
   reorder and persist across reload.

## Consequences to accept

- ~96 `Pane.define` call sites each gain an Actions slot, so the manifest roughly
  doubles (111 → ~215) and that many config descriptors are registered on both
  runtimes. This is the price of reorderable pane actions; it is the change's
  point, not a side effect.
- Every slot-owning barrel gains a `slots: [...]` line. The orphan guard turns
  that from a migration to be audited by hand into a list the build hands you.
- Documented factory-slot output grows, so `CLAUDE.md` files and
  `docs/plugins-{compact,details}.md` regenerate widely. Automatic on build,
  enforced by `plugins-doc-in-sync`.

## Follow-ups (filed, not in scope)

- **Derived slot ids** (`task-1786959985810-5htvbq`) — make a computed id
  unspellable by deriving it from the owning plugin id plus the declaration key.
  Blocked on a config migration: slot ids are config paths, so ~112 directive
  files plus their `.origin.jsonc` twins move, and a plain rebuild after an id
  change would let `pruneOrphanedConfigFiles` delete authored overrides before
  anything rewrites them.
- The remaining loudness work on the genuinely-textual scanners
  (`resources/facet/parse-resources.ts`, `routes/facet/index.ts` — whose `:33-35`
  only walks this plugin's `core`/`shared`, silently dropping a cross-plugin
  endpoint — and `durable-signals-accounted/check/index.ts:38-50`). Independent of
  this plan; ~45 LOC total.
