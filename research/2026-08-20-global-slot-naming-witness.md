# A slot id cannot be read without the pass that mints it

Status: **implemented** 2026-08-21 (see "What actually landed" at the foot of this doc for the
two departures from the sequence below). Follow-up to
[`2026-08-18-global-derived-slot-ids.md`](./2026-08-18-global-derived-slot-ids.md), which made a
slot's id derive from its declaring plugin. This closes the hole that left in the build-time
readers.

---

## Context

A slot has no id of its own. Its id is `${pluginId}.${key}`, stamped onto the slot object by a
**declaration pass** (`declarePluginSlots`) that walks plugins and reads their `slots` record. Until
a pass runs, the slot is nameless — `slot.id` throws, and `declaredSlotId(slot)` returns `undefined`.

That works at runtime: `PluginProvider` runs the pass before it reads any plugin's contributions.
It does not work for the **build-time** readers — the checks and generators that import plugin
barrels directly to ask "who contributes to slot X?". Each must remember to run a pass first, and
nothing enforces it.

**The failure is shaped like success.** Without a pass every `declaredSlotId` returns `undefined`,
so a consumer matching contributions against a slot id matches nothing and emits an empty set.
Downstream that reads as "this plugin contributes nothing", not as a tooling failure. Two consumers
failed exactly this way while derived ids were landing: `token-group-vars` emitted an empty var set,
which made `css-vars-supplied` report real CSS variables as having no supplier; and
`facets:render-complete` reported all 27 render surfaces missing. Neither error mentioned slots.

This is the repo's own banned pattern — *failure must be a type, not an absorbable value* — sitting
in the one function that reads a slot's name. `undefined` currently means three different things:
"this contribution targets no slot", "this slot's plugin is disabled and out of scope", and "no pass
ran, I cannot answer".

There is one loud guard today: `contributions/facet/index.ts:100` throws when barrels are imported
with zero passes. It covers that one facet, and it is a runtime assert rather than something that
makes the mistake unspellable.

### Two things the fix has to respect

**The passes are not interchangeable.** `declareSlotsFromBarrels` models the **live registry** and
deliberately skips disabled plugins — declaring them would make web and server register different
config descriptor sets and fail `config-v2:registrations-paired`. But a consumer asking what the
**source** declares needs them: `facets:render-complete` checks the surface
`review.plugin-changes.diff-renderer`, owned by `review/plugins/plugin-changes`, which is disabled.
So that check runs its own inclusive pass by hand.

**Some consumers need no pass at all.** A reader wanting ids only for slots its own plugin declares
composes `${pluginId}.${seg(key)}` locally. The slots facet does this, with no barrels involved.
That escape hatch stays.

### What the investigation turned up

**1. Scope is currently a global mutable, and check verdicts are cached.** Stamps are written onto
the shared slot objects and never cleared, so scope is "the union of every pass run so far in this
process". `runner.ts:490` runs checks under `Promise.all`, so which passes have landed when a given
check reads is a matter of *interleaving*. `plugins/review/plugins/plugin-changes/web/slots.ts`
declares `Section: defineRenderSlot()` — a reorderable slot in a disabled plugin — so once any check
builds the enriched tree, that slot is stamped and `declaredSlotId` returns a name for it.

`reorderable-slots-gen.ts:110-121` documents its disabled-filter as coming from "a disabled plugin's
slots are never declared". That is false in the check process. The only thing keeping the slot out
of the manifest is an incidental `owners.get(slotId) === undefined` on the next line.

This is not a taste call. `tooling/core/types.ts:71-78` states the rule verbatim: a `"tree"` check's
verdict *"must be a function of the tree hash AND of NOTHING ELSE, including what else already ran
in this process"* — because the runner **caches a pass and a later `./equin push` trusts it
from a different process**. The doc's own worked example of that going wrong is this same
declaration-pass bug class, which shipped a bad `docs/plugins-details.md` across four commits.

**2. An independent live instance of the same bug class.**
`plugins/page/plugins/editor/check/index.ts:401-402` reads `c._slotId`, a field that no longer
exists (it is `_slot: SlotHandle` since the identity-dispatch change). Repo-wide, `_slotId` survives
only there and in one stale test fixture. So the predicate is always true, `handles` is always
empty, and `collectBlockHandles` returns `{ ok: true, handles: [] }`.

Both callers — `page.editor:split-targets-are-text-bearing` and `page.editor:block-prefixes-unique`
— have a carefully worded "this is a check/tooling failure, not a clean pass" arm, and both are
bypassed, because the emptiness happens one level below the `{ ok: false }` guard (which only covers
`candidateDirs.size === 0`). Two checks have been verifying nothing.

Note what would and would not have caught it: a witness for the *id read* would not have. **Identity
comparison would** — there is no field name left to misspell.

---

## The design

### Layer 1 — the naming witness, resolver-first

Remove `declaredSlotId` as a free export. A declaration pass returns a `SlotNaming`, and reading a
slot's name is a method on it. The only ways to obtain one are running a pass or holding an enriched
tree, so "read the id without a pass" has no spelling (rung 1).

```ts
export interface SlotNamingEntry { slot: SlotHandle; id: string; pluginId: PluginId; key: string }

/** Two states, not one nullable string — see "the three meanings" below. */
export type SlotLookup =
  | { kind: "named"; id: string; pluginId: PluginId; key: string }
  | { kind: "out-of-scope"; scope: SlotScope };

export interface SlotNaming {
  /** The slot this pass declared under `id`. THROWS — a wrong or out-of-scope id. */
  slotNamed(id: string): SlotHandle;
  /** Probe form, for a caller that must turn absence into its own failure value. */
  findSlot(id: string): SlotHandle | undefined;
  /** Note the parameter: `SlotHandle`, never `SlotHandle | undefined`. */
  idOf(slot: SlotHandle): SlotLookup;
  /** Every declaration this pass settled. */
  declarations(): readonly SlotNamingEntry[];
  /** Preserved, so existing owners-map consumers are untouched. */
  owners: ReadonlyMap<string, PluginId>;
}
```

**The three meanings, and why each one goes.** Today `declaredSlotId(slot: SlotHandle | undefined):
string | undefined` answers three questions with one `undefined`: *this contribution targets no
slot*; *no pass ran, I cannot answer*; and *declared by nobody in this scope*. Only the third is a
real answer. The fix separates them structurally rather than by convention:

- **"no pass ran"** is not an arm because it is not reachable — `idOf` is a method on a naming, and
  only a pass mints one.
- **"targets no slot"** leaves this function entirely. Dropping the `| undefined` parameter moves it
  to the call site, beside the branch it belongs next to:
  `if (c._slot) { naming.idOf(c._slot) } else if (typeof c._kind === "symbol") { … }`.
- **"out of scope"** becomes a named arm carrying its scope, so the message reads *"not declared
  under registry scope, which excludes disabled plugins"* instead of being an empty result.

Returning a union rather than `string | undefined` is what makes the remaining state
**unabsorbable**: `id` exists only on the `named` arm, so a consumer cannot reach it without
discriminating, and there is no `undefined` left to `!==` against. Same shape as the primitives
that own their pending affordance — the state is the return type, not a value standing in for one.

A third arm separating *out-of-scope* (declared, by a plugin this scope skips) from *undeclared*
(an orphan no plugin declares anywhere) was considered and rejected: registry scope cannot tell them
apart without importing disabled barrels, which `runDeclarationPass` deliberately does not do — an
imported-but-undeclared barrel would put slots in the created-set with no owner and poison the
orphan guard. The orphan case is owned by `assertSlotsDeclared`, which fails the build before any
consumer reads. Source scope could supply the third arm if one is ever wanted.

**Resolving is primary, not `idOf`.** Six of the eight `declaredSlotId` usages are not id reads at
all — they are `declaredSlotId(c._slot) === "<string literal>"`. Wrapping the id read would leave
the literal on the right-hand side absorbable: a stale hand-spelled id yields zero matches, i.e. the
identical silent-empty. It has drifted before (`registrations-paired.ts:92-94` documents
`config-v2` → `config_v2`). So those sites resolve **once, outside the loop**, and compare by
identity inside it:

```ts
const blockSlot = naming.slotNamed("page.editor.block");   // or findSlot, in a check — see below
…
if (c._slot !== blockSlot) continue;
```

Three things improve at once: a wrong id is a named failure at one line instead of an empty result;
the loop composes no strings; and there is no field name to misspell, which is the `_slotId` bug
above.

**`idOf` returns a state; it does not throw.** It must not throw, because the contributions facet
legitimately meets an out-of-scope slot under source scope (a disabled plugin's orphan), and the
orphan guard is registry-scoped on purpose. The `out-of-scope` arm is a real answer that consumer
acts on, not a failure to report.

Built as a frozen closure inside `declarePluginSlots`, from the same loop that stamps. No class —
`core/` is functional here.

### Layer 2 — scope carried by the answer, not by global stamps

`SlotNaming` holds its **own** `Map<SlotHandle, string>` and `Map<string, SlotNamingEntry>`, built
by that pass, instead of everyone reading the shared mutable stamps. Runtime stamps stay for the
browser's `slot.id` getter; this is additional.

That restores tree purity: a naming is complete when its promise resolves, so no check's answer
depends on what another concurrently-running check has stamped. It also lets
`reorderable-slots-gen` walk `naming.declarations()` instead of the global `getCreatedSlots()`,
which deletes the accidental `owners.get()` filter, the false comment, and the last build-time
consumer of the global created-set outside the orphan guard.

One scoped entry point replaces the two ad-hoc ones:

```ts
declareSlotsFromBarrels(root, scope: "registry" | "source"): Promise<SlotNaming>
```

memoized per `(root, scope)`. The facets check drops its hand-rolled loop and asks for `"source"`.

### Layer 3 — pair "modules imported" with "slots declared" on the facet path

In `facets/core/facets.ts`, `ExtractContext.importedModules?: {mod, runtime}[]` becomes
`imported?: { modules: {mod, runtime}[]; naming: SlotNaming }`. Three facets consume it
(`contributions`, `slots`, `registrations`), plus `plugin-tree` and one test.

The pair makes "has modules but no naming" inexpressible for the path five of the eight consumers
use, which lets the `slotDeclarationPasses() === 0` runtime throw be **deleted** (rung 4 → rung 1),
and `slotDeclarationPasses()` with it — no other consumer.

### Layer 4 — one composition site

`slotIdFor(pluginId, keyPath)` in `slot-declaration/core`. Six spellings of
`` `${pluginId}.${key}` `` collapse to one: the `id` getter (`web-sdk/core/slots.ts:47`),
`declarePluginSlots`, and the slots facet's four sites.

### Deliberately not doing: the barrel funnel

A `readPluginBarrels(root, scope)` chokepoint plus a lint ban on raw `importBarrel` was considered
and is **deferred**. After Layer 1 there is no consumer left that it would save: every one of the 14
`importBarrel` call sites that reads a web barrel's `contributions` does so *in order to filter by
slot*, so each already holds a naming. And one funnel would have to serve four incompatible shapes
(web+server per node; a facet-derived subset of dirs; three runtimes in a fixed order;
disabled-filtered web only) — an options bag growing to the union of its callers.

---

## Landing sequence

### Commit 0 — the dead `_slotId` read (independent bug, land first)

- `page/plugins/editor/check/index.ts:401-402` — `c._slotId` → `declaredSlotId(c._slot)`
  (pre-migration form; commit 3 converts it to identity).
- Same file, `collectBlockHandles` (`:374-409`) — return `{ ok: false }` when `handles` is empty.
  The empty-but-ok return is what let this hide, and both callers already word the degraded arm.
- `facets/plugins/contributions/facet/declaration-guard.test.ts:25` — fixture `_slotId` → `_slot`.

**Expect this to newly FAIL.** Two checks have been verifying nothing; budget for real violations
surfacing, and fix them here rather than folding them into a later commit.

### Commit 1 — `SlotNaming` (no behaviour change)

`slot-declaration/core/declaration.ts`: add `SlotNamingEntry` / `SlotNaming` and a private
`makeNaming`; `declarePluginSlots` builds both maps in the loop that stamps and returns a frozen
naming carrying `owners`; `SlotDeclarationListener` takes it (bodies unchanged — it exposes
`.owners`). Keep `declaredSlotId` for now.

Type-only ripples: `codegen/core/slot-declaration-guard.ts:100`, `web-sdk/core/context.tsx:70`,
`plugin-tree.ts:431`, `reorder/web/internal/config-registrations.ts:32`,
`reorderable-slots-gen.ts:99`.

New `slot-declaration/core/naming.test.ts` — the scope-isolation case is the point of the change:

1. Pass A over `{enabled}`, pass B over `{enabled, disabled}`; after B, `A.idOf(disabledSlot)` is
   still `undefined` and `A.findSlot(disabledId)` is still `undefined`.
2. `slotNamed` throws on an unknown id, naming the id.
3. `declarations()` is exactly the pass's set, and `idOf` agrees with `${pluginId}.${key}`.

### Commit 2 — scope the barrel pass; retire the hand-rolled one

`codegen/core/slot-declaration-guard.ts`: add `SlotScope`; `declareSlotsFromBarrels(root, scope)`
memoized on `` `${scope}\0${root}` ``; `runDeclarationPass` skips the `disabled.has(node.id)` filter
under `"source"`. `assertSlotsDeclared` passes `"registry"` and its doc says the orphan guard is
registry-scoped *on purpose* and must not be "completed" by switching it.

`plugin-meta/plugins/facets/check/index.ts`: delete the hand-rolled pass (`:70-84`); take
`"source"`; resolve `RENDER_SURFACES` to handles once via **`findSlot`**, mapping a miss to
`{ ok: false }`; inner loop compares `s.slot === c._slot`.

### Commit 3 — migrate every id read; delete `declaredSlotId`

- `reorderable-slots-gen.ts:95-125` — walk `naming.declarations()`, filter
  `entry.slot.meta.reorderable`. Drops `getCreatedSlots`, the `owners.get()` line and the `seen`
  set. **Replace the false comment**: the set is this pass's declarations, and no other pass can
  widen it.
- `plugin-tree.ts:431` — capture the naming onto `tree.naming`; pass `imported: { modules, naming }`
  into `facet.extract`. `enriched-tree.ts` exposes it so the page checks reach it without a second
  pass.
- `facets/core/facets.ts` + the three consuming facets — `ctx.imported?.modules`. The contributions
  facet is the one site that genuinely wants an id string: it branches on
  `naming.idOf(c._slot)`'s arms (`"named"` → emit the id into docs; `"out-of-scope"` → skip, which
  is the disabled-plugin case it already means to skip), moves its web/server discriminator to
  `c._slot` presence, and **deletes** the `slotDeclarationPasses() === 0` throw — keeping the
  incident story as the *why* for the paired ctx.
- `slot-declaration/core` — remove `declaredSlotId` and `slotDeclarationPasses`.
- `token-group-vars-gen.ts:93-118` — `slotNamed(...)` (a generator *should* abort) + identity compare.
- `registrations-paired.ts:60,95`, `page/plugins/editor/check` (`:219,:226,:312,:402`),
  `page/plugins/annotations/check:117` — resolve once via `findSlot`, `{ ok: false }` on a miss,
  identity compare.

Two notes for this commit. `Editor.Block` is a `defineSlotFacade` (`page/plugins/editor/web/slots.ts:171`)
whose contributions carry the **target** slot, which is also what `collectSlots` declares — so
identity matches. And `SERVER_BLOCK_DATA_SLOT` stays a string: it is a `_kind` symbol description,
not a slot id.

### Commit 4 — `slotIdFor`, six sites to one

Independent of the rest; land last so no doc churn mixes into commit 3.

---

## The one ergonomic constraint that decides the API

**A thrown check aborts the entire run.** `runner.ts:490-527` awaits every check under
`Promise.all` and rethrows, so one `slotNamed` throw inside a check kills every other check's
reporting. Therefore:

- **Generators throw** — `token-group-vars-gen`, `reorderable-slots-gen`. Aborting is correct.
- **Checks use `findSlot` and return `{ ok: false }`** with a message naming the id and the scope.

This is why the interface ships both forms rather than picking one.

## Build vs check — where they diverge

- **Do not move source scope earlier in the build.** `regen-pipeline.ts:177-196` is load-bearing:
  registry guard → `postWebManifests` → `pluginDocs` (where source scope happens today, inside the
  enriched tree). A source pass before the guard would import disabled barrels for the first time
  ahead of the freeze-point guard's assumptions and ahead of the created-set the orphan report reads.
- **Registry consumers now state their scope.** In a build, `token-group-vars` and
  `registrations-paired` run after the enriched tree has already run source scope in the same
  process. Today that is safe only incidentally; after this it is stated.
- **The manifests must not move a byte** — `reorderable-slots.generated.ts` and
  `token-group-vars.generated.ts`, in both processes. If either moves, the change has exposed a real
  divergence: investigate, do not accept.

## Verification

```
./equin check page.editor:split-targets-are-text-bearing   # commit 0 — expect a real failure first
./equin check page.editor:block-prefixes-unique
./equin test plugins/framework/plugins/slot-declaration    # commit 1 — scope isolation is the point
./equin check facets:render-complete                       # commit 2
./equin test plugins/plugin-meta/plugins/facets            # commit 3
./equin check reorderable-slots-in-sync
./equin check token-group-vars-in-sync
./equin check css-vars-supplied
./equin check css-vars-single-owner
./equin check inherited-theme-defaults-scoped
./equin check config-v2:registrations-paired
./equin check plugins-doc-in-sync
./equin check plugin-boundaries
./equin check type-check
./equin check                                              # full, every commit
```

**The purity probe — the regression test for the hazard, and the only thing that proves the fix.**
Run `./equin check reorderable-slots-in-sync` **alone**, then inside a full run. Both must
pass. Today that agreement is accidental and interleaving-dependent, and a wrong verdict would be
*cached* and trusted by a later `push` from another process.

Finally `./equin build` in the background, end the turn, then confirm
`~/.singularity/worktrees/<wt>/build-status.json` says `status: ok` and `git status` shows **zero**
diff under `config/`, `docs/`, and the two `.generated.ts` manifests. Any `config/` churn means a
slot id moved — stop and investigate.

## Critical files

- `plugins/framework/plugins/slot-declaration/core/declaration.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/slot-declaration-guard.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`
- `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`
- `plugins/plugin-meta/plugins/facets/core/facets.ts`
- `plugins/page/plugins/editor/check/index.ts`

---

## What actually landed (2026-08-21)

Implemented and verified; deployed at `http://att-1787229633-87vy.localhost:9000`.
`config/` untouched throughout, and `docs/plugins-details.md` drift was additions plus the
two intended removals — nothing shrank, which is the evidence that the facet reports the same
set through the new path.

Two departures from the sequence above, both forced by things found while building it.

### Commit 3's first half was pulled forward, because commit 1 turned a test red

Commit 1's `naming.test.ts` calls `declarePluginSlots` four times. bun:test shares module state
across files in one process, so the counter behind the contributions facet's
`slotDeclarationPasses() === 0` assert was non-zero by the time
`declaration-guard.test.ts` ran, and the assert could no longer fire. Its own header had
stated the assumption — *"nothing imported here declares slots, so the first test below
genuinely observes a virgin process"* — which stops being true the moment any sibling file
runs a pass.

That assert was a test of global process history, i.e. the same disease as the stamps. Patching
it would have meant adding a reset hatch to the state being deleted, so the pairing (Layer 3)
was landed early instead and the assert deleted. Sequencing note for anything similar: adding a
test that exercises process-global state can invalidate an assert that reads it.

### A concurrency defect the scoping introduced, and a cached `ok` that hid it

Splitting the memo key from `root` to `(scope, root)` created two independent passes, each with
its own barrel-import loop over the same modules. `checks/core/runner.ts` awaits every check
under `Promise.all`, so both can be in flight at once, and one reads `mod.default` off a module
the other is still evaluating:

```
ReferenceError: Cannot access 'default' before initialization
  at declaredSlotSources → runDeclarationPass → facets/check/index.ts
```

Reproducer: `./equin check --no-cache reorderable-slots-in-sync facets:render-complete`
crashes; either check alone passes.

The fix is a `createSemaphore(1)` lane inside **`importBarrel`**, not in the callers — the race
was never confined to the two scoped passes. Roughly seven call sites run their own
barrel-import loop and none were ever inside the old per-root memo, so they could always
overlap; scoping only made one pair reproducible. The old serialization was an accident of
memoization that nothing stated, which is why the lane carries a DO-NOT-REMOVE note.

**The check reported `ok (cached)` while crashing uncached.** A cached verdict is what
`./equin push` trusts from another process, and this one was green over a hard failure.
It happened twice in one session, both times on a check whose own source had just changed.
Whether a check's own code is part of what invalidates its cache entry is worth a look on its
own — see the tree-purity rule at `tooling/core/types.ts:71-78`. **Use `--no-cache` when
verifying a check you have just edited.**

### Smaller things found on the way

- `page/editor/check`'s `collectBlockHandles` had three distinct degradations — slot
  unresolvable, no candidate dirs, no handles — collapsing into one message naming only the
  likeliest, so a failure could not be read as "the check is broken" vs "the invariant is
  violated". It now carries a `reason`.
- `PluginTree.naming` was rejected as the way page checks reach a naming: the source pass runs
  only inside the facets block, so the field would be `naming?: SlotNaming` — reintroducing the
  nullable this change deletes. They call the memoized `declareSlotsFromBarrels(root, "registry")`
  directly, which `buildEnrichedTree` has already paid for.
