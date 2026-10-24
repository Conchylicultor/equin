# Fix A — Deterministic reorderable-slots scan

Status: design (read-only planning). Sibling: **Fix B** (push-time `regen-generated`
regenerates the same manifest set the full build does). Fix A is the foundation:
make the slot scan a pure function of committed source so that whatever Fix B (or
the in-sync check) re-runs at push time yields the identical manifest in any
environment.

---

## 1. Confirmed root-cause mechanism (with file:line evidence)

### 1.1 The two generators share one scan, and that scan is a *live barrel walk*

Both the contributions doc count and the reorderable-slots manifest derive from
the **same** enriched tree, built once and cached:

- `buildEnrichedTree(root)` → `buildPluginTree(resolve(root,"plugins"))` **with no
  `skipBarrelImport`**, memoized in `enrichedTreeCache`
  (`plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts:136-145`).
- `generatePluginDocs` consumes it (`docgen.ts:218-219`) → emits the
  `Contributes: ConfigV2.WebRegister ×N` lines from the **contributions** facet.
- `generateReorderableSlots` → `renderReorderableSlotsManifest` →
  `collectReorderableSlots` calls the *same* `buildEnrichedTree`
  (`reorderable-slots-gen.ts:66`) and reads the **slots** facet.

So in a single `./equin build` process the doc count and the manifest are
consistent *within that run*. The non-determinism is **across processes/environments**,
and it enters through how the tree gets populated.

`buildPluginTree` imports every `web|server|central/index.ts` barrel as a live ES
module under Bun stubs (`plugin-tree.ts:308-340`, `importBarrel`,
`registerBarrelStubs`). The barrels' module-init side effects register slots.

The **slots facet** has two extraction modes
(`plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts:149-189`):

- **Runtime walk** (`importedModules.length > 0`) — declared the *"SOLE
  authoritative source"* (`facet/index.ts:161-163`, `collectRuntimeSlots`
  at `:106-144`). It recursively walks the **live export object graph** of every
  imported barrel and records any value that is `isSlotLike` (`:14-16`), reading
  `kind` off the runtime marker (`.Render` → render) via `runtimeKindHints`
  (`:79-86`).
- **Static parse** fallback (`skipBarrelImport`, no imports) — `parseSlotCalls`
  over `web/slots.ts` text (`:165-188`). **This fallback explicitly skips any
  `defineRenderSlot` whose id is not a plain string literal**
  (`:46-47`: `if (!slotId) continue;` for template/identifier expressions).

Because `buildEnrichedTree` never passes `skipBarrelImport`, the real build and
the in-sync check both use the **runtime walk**. The static parser is dead code
on this path.

### 1.2 Why the runtime walk is the only thing that "sees" most slots

The manifest has **71** entries, but a grep of literal `defineRenderSlot(` call
sites in `web/slots.ts` files finds only a handful of statically-resolvable ids.
The majority of reorderable slots are **factory-produced with computed ids**:

- `defineDetailSections(id)` → `defineRenderSlot(\`${id}.section\`)`
  (`plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx:31-38`).
  Produces `task-detail.section`, `build-detail.section`, `plugin-view.section`,
  `review.section`, `theme-customizer.section`, `table-detail.section`,
  `pages.detail.section`, …
- `definePaneToolbar(idBase)` → `defineRenderSlot(\`${idBase}.start\`)` +
  `\`${idBase}.end\`` (`plugins/primitives/plugins/pane-toolbar/web/internal/define-pane-toolbar.tsx:81-82`).
  Produces `story.toolbar.start/end`, `sonata.toolbar.start/end`, …
- `defineItemActions(...)`, the app-shell sidebar/toolbar factory, etc.

The factory **call sites pass static string-literal arguments**
(e.g. `definePaneToolbar("story.toolbar")`,
`plugins/apps/plugins/story/plugins/shell/web/toolbar.ts:11`), but the
`defineRenderSlot` call itself lives **inside the factory file** and uses a
template literal. So:

- The current **static** mode can NEVER see these slots (template-literal id →
  skipped). That is exactly why the build was wired to the runtime walk.
- The current **runtime** mode sees them only by *evaluating* the closure — i.e.
  the slot set is a function of *which barrels successfully imported and what
  their module-init code did*, not of committed text.

### 1.3 The actual non-determinism vector

The runtime-walk slot set is environment-sensitive on several independent axes,
all rooted in "the scan depends on import-time evaluation, not on source text":

1. **Barrel-import success is environment-dependent.** `importBarrel` evaluates
   real plugin code under Bun stubs (`stubs.ts:159-223`,
   `auto-stubs.generated.ts`). The stub set is itself a **committed generated
   file** (`barrel-import/core/internal/auto-stubs.generated.ts`, git-tracked) and
   is gated by its own `barrel-stubs-in-sync` check. If a barrel's transitive
   imports differ between environments (a freshly-added npm dep not yet stubbed,
   a stale `auto-stubs.generated.ts`, `node_modules` skew, a module that throws at
   init only under one stub shape), `importBarrel` **throws**
   (`stubs.ts:231-238`) and `buildPluginTree` does **not** catch it
   (`plugin-tree.ts:330` — no try/catch). In the worktree that pushed, the import
   path succeeded and produced the factory slots; on `main` a slightly different
   environment can produce a different live closure. The walk's output is "whatever
   evaluated", and evaluation is not hermetic.

2. **`hasPluginContent` / hollow-shell skew (already a known divergence axis).**
   `plugin-tree.ts:93-125` documents the exact failure class: leftover untracked
   `node_modules/` shells from `git mv` exist on the long-lived `main` worktree but
   not in fresh worktrees, so the *set of plugin dirs* (and thus the set of barrels
   imported, and thus the slots discovered) **diverges between a clean worktree and
   a cruft-laden main**. The gate fixes the dir-discovery half; the slot half still
   rides on which barrels evaluate.

3. **The contributions facet's count is derived from the same live import.** The
   `ConfigV2.WebRegister ×N` doc lines come from `reorder`'s barrel exporting
   `def.contributions[]` (`contributions/facet/index.ts:81-103`), and that array is
   `reorderConfigContributions = reorderDescriptorEntries.map(...)`
   (`plugins/reorder/web/internal/config-registrations.ts:14-16`) — i.e. **one entry
   per row in `reorderableSlots`** read from the committed manifest. So the doc
   count is downstream of *the committed manifest the reorder barrel imports at
   eval time*, while the manifest the build *writes* is downstream of *the live
   slot walk*. Two different inputs that are only equal when nothing has drifted.

### 1.4 The committed drift this produced (the 72↔71↔70 history)

- Manifest moved 72→71 at commit `b735eb0bd` "fix(pages): unify the page-detail
  top bars into one" (`git show b735eb0bd -- …/reorderable-slots.generated.ts`
  removes the `pages.toolbar` row).
- That same commit regenerated `docs/plugins-compact.md` and
  `docs/plugins-details.md` but **did NOT regenerate `plugins/reorder/CLAUDE.md`**
  (`git show b735eb0bd --stat` — `reorder/CLAUDE.md` is absent from the file list).
- Result, in the current tree:
  - `plugins/reorder/shared/reorderable-slots.generated.ts` = **71** rows.
  - `plugins/reorder/CLAUDE.md` = **72** `ConfigV2.WebRegister` lines (stale — last
    touched at `bd395c56c`, before `b735eb0bd`).
  - `docs/plugins-details.md` = **71** `ConfigV2.WebRegister` lines for reorder
    (regenerated at `b735eb0bd`).

The reorder barrel imports the **committed 71-row manifest**, so a *fresh* doc
scan emits 71; `reorder/CLAUDE.md` is stuck at 72 because nothing rewrote it. The
"71 vs 70" split observed between a pushing worktree and a clean `main` build is
the same class one notch further: the live slot walk on `main` (different barrel
eval / hollow-shell set) discovered one fewer factory slot than the worktree did.

**Summary:** the scan is non-deterministic because it is a *live-barrel-evaluation
walk* whose output depends on (a) which barrels import successfully and (b) what
their init code computes — neither of which is a pure function of committed
source. The two generators only stay in agreement when nothing has drifted; the
moment one regenerates and the other doesn't (or one environment imports a
different closure), the counts split.

---

## 2. The exact slot that flips, and why

- **`pages.toolbar`** (`pluginId: apps.pages.shell`).
- It existed because the Pages app shell registered an (empty) `Pages.Toolbar`
  render slot. `b735eb0bd` dropped the redundant `toolbarSlot` and removed the
  slot from `…/pages/plugins/shell/web/slots.ts` (the current `slots.ts` defines
  only `Pages.Sidebar`). The manifest correctly went 72→71.
- It is the *last* item in the manifest's lexical region around `pages.*`, so when
  one generator regenerates and the other reads a cached/committed copy, this is
  the row that appears/disappears. The same factory-slot fragility (a slot that
  exists only because a barrel evaluated and registered it) is why an environment
  that fails to evaluate one factory closure lands on 70 instead of 71.

(The "which specific slot is the 71↔70 flip on `main`" depends on whichever
factory barrel failed to evaluate or whichever hollow shell was present on that
checkout; the mechanism is identical — a live-walk-only slot. `pages.toolbar` is
the concrete, reproducible 72→71 case in committed history.)

---

## 3. Proposed design

**Goal:** the reorderable-slot set is a pure, deterministic function of committed
source — identical with or without prior build artifacts, in any worktree or main.

**Principle (CLAUDE.md top rule):** fix the structural cause — "the scan evaluates
code instead of reading source" — not the symptom (don't just re-run docs at push
time and hope). The clean primitive is a **static slot scanner that resolves
factory-produced ids from source**, made the single source of truth for both the
manifest and the contributions/doc surface.

### 3.1 Make the slot scan static and factory-aware

Replace the live-barrel walk (for the purpose of *the reorderable-slots set*) with
a static scan that:

1. Scans every plugin's web source (not just `web/slots.ts` — factories live in
   `web/internal/*.tsx`, app `toolbar.ts`, etc.) for `defineRenderSlot(...)` calls
   via `findMarkerCalls` (`parse-utils/core/find-marker-calls.ts`) so
   comments/strings never match.
2. For a **plain string-literal id**, record it directly (today's `parseSlotCalls`
   already does this).
3. For a **template-literal id inside a factory** (`\`${idBase}.section\``), record
   the factory as a *slot-producing factory* with a known suffix set:
   - `defineDetailSections(id)` → `${id}.section`
   - `definePaneToolbar(idBase)` → `${idBase}.start`, `${idBase}.end`
   - any other `defineRenderSlot(\`${X}.<suffix>\`)` inside an exported factory →
     `<suffix>` extracted from the template literal's static tail.
   Then scan **factory call sites** (`definePaneToolbar("story.toolbar")`,
   `defineDetailSections("task-detail")`) for their string-literal first argument
   and expand `arg + suffix` for each suffix the factory emits.

The cleanest encoding of (3) is a **small registry of slot-producing factories**
discovered structurally rather than hardcoded: a factory file declares it produces
reorderable slots by the *shape* `export function defineX(idBase|id): … {
defineRenderSlot(\`${idBase}.suffix\`) }`. The scanner derives `{ factoryName,
suffixes[] }` from that shape, then resolves call-site literals. This keeps the
collection-consumer separation intact (no consumer names a specific factory) and
makes *future* factories work with zero scanner edits — the suffix set is read
from the factory source, not enumerated in the scanner.

This is implemented as a new pure function in
`plugin-meta/plugins/facets/plugins/slots/facet` (and/or the codegen core) — e.g.
`collectRenderSlotsStatic(tree)` — returning `{ slotId, pluginId }[]` with zero
dependence on `importedModules`.

### 3.2 Unify the manifest and the contributions count behind one source of truth

The `ConfigV2.WebRegister ×N` doc line must be derived from the **same static slot
set** as the manifest, never from a separately-evaluated `reorder` barrel import.
Two equivalent ways, pick the lower-risk one:

- **Preferred:** `reorderConfigContributions` already maps 1:1 over
  `reorderableSlots` (the committed manifest). So once the manifest is a
  deterministic static artifact, the contributions facet should attribute reorder's
  WebRegister count to **the manifest length**, not to a live barrel walk. Concretely:
  the contributions facet, for the `reorder` plugin's `ConfigV2.WebRegister` group,
  reads the committed/just-regenerated manifest length rather than `def.contributions`.
  This makes "doc count == manifest length" a structural identity.
- **Alternative (lighter):** keep the contributions facet as-is but ensure
  `generatePluginDocs` and `generateReorderableSlots` always run together and read
  the same enriched tree (they already do in `build.ts`). This removes *within-run*
  drift but NOT cross-environment drift — so it is insufficient on its own. Only
  the static scan (3.1) removes cross-environment drift.

### 3.3 Keep the runtime walk where it is genuinely needed

The runtime walk also feeds non-reorder facet surfaces (contribution display
names, factory-slot discovery for the Studio detail pane). Fix A does **not** need
to rip it out globally — it needs the **reorderable-slots manifest** (and the
reorder WebRegister count) to stop depending on it. The slots facet can keep its
runtime mode for the detail/diff surfaces while `collectReorderableSlots` switches
to the new static collector. (If, after 3.1, the static collector provably covers
every factory slot the runtime walk found, a follow-up can retire the runtime walk
entirely — note it as future work, out of Fix A scope.)

### 3.4 Why `./equin check` then reliably catches drift

After 3.1+3.2:
- `renderReorderableSlotsManifest(root)` becomes a pure function of source text.
- `reorderable-slots-in-sync` (`…/checks/plugins/reorderable-slots-in-sync/check/index.ts:34`)
  compares the committed file against that pure render — so it produces the same
  verdict in every environment. No more "passes in worktree, fails on main".
- `plugins-doc-in-sync` will catch the `reorder/CLAUDE.md` 72-vs-71 staleness the
  moment the doc count is tied to the manifest length (it currently does not,
  because the stale doc was simply never regenerated alongside `b735eb0bd`).

---

## 4. Implementation checklist (files / functions)

1. **New static collector** — `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`
   (or a new `…/slots/core/static-collect.ts` if it must be importable without the
   facet runtime):
   - Add `collectFactorySlotProducers(src)`: from a factory file, find each
     `defineRenderSlot(\`${param}.<suffix>\`)`, extract the static `<suffix>` and the
     enclosing exported factory name + its id parameter position.
   - Add `expandFactoryCallSites(tree, producers)`: scan all web source for calls to
     each producer, read the literal id arg via `findMarkerCalls` + `parseStringField`,
     emit `arg + suffix` per suffix.
   - Combine with the existing literal-id `parseSlotCalls("defineRenderSlot","render")`
     to yield the full `{ slotId, definingPluginId }[]`, deduped by slotId, first
     definer wins (mirrors current `definingPath` logic).
   - Reuse `maskSource` / `findMarkerCalls` / `matchBracket` / `parseStringField`
     from `@plugins/plugin-meta/plugins/parse-utils/core` (no AST, per repo
     convention).

2. **Switch the manifest generator to the static collector** —
   `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`:
   - In `collectReorderableSlots` (`:63-104`), replace the
     `getFacet(node, slotsFacetDef)` runtime-derived `definingPath` loop with the
     new static collector. Keep the `catalog` map (origin defaults/annotations) on
     the same static slot set so the materialized origin stays consistent.
   - `renderReorderableSlotsManifest` / `generateReorderableSlots` signatures
     unchanged (Fix B and the in-sync check keep calling them as-is).

3. **Tie the reorder WebRegister doc count to the manifest** —
   `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`:
   - For the `reorder` plugin's `ConfigV2.WebRegister` contributions, derive the
     count from the manifest length (the static slot set) rather than the live
     `def.contributions` walk, OR ensure the reorder barrel's contribution array is
     itself read from the freshly-regenerated manifest. Pick the option that keeps
     the contributions facet generic (do not special-case by plugin name in a way
     that leaks the abstraction — prefer "WebRegister contributions reflect the
     manifest" expressed generically).

4. **Regenerate stale doc** — `plugins/reorder/CLAUDE.md` (72→71) will self-correct
   once 3 lands and docs regenerate; the `plugins-doc-in-sync` check enforces it.
   (No hand edit — regenerated by build/regen-generated.)

5. **Unit test (optional, bun:test, co-located)** — a `*.test.ts` next to the static
   collector asserting: literal-id slots, `defineDetailSections("x")` → `x.section`,
   `definePaneToolbar("y")` → `y.start`/`y.end`, and that a commented/stringified
   `defineRenderSlot("z")` is NOT picked up (mask coverage). Determinism: same input
   → identical ordered output.

Files I expect to touch (overlap with Fix B flagged in §6):
- `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts` ← also Fix B
- `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts` (+ maybe `…/slots/core/`)
- `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`
- `plugins/framework/plugins/cli/bin/commands/regen-generated.ts` ← Fix B's edit; Fix A must ensure the function it calls is deterministic

---

## 5. Verification

Read-only/manual (do NOT run `./equin build` or `push`):

1. **Static-equivalence check (the key proof):** after implementing, the new
   `collectReorderableSlots` must reproduce the current committed 71-row manifest
   exactly. Compare its output to `plugins/reorder/shared/reorderable-slots.generated.ts`
   (71 rows, sorted by slotId). Every factory slot (`*.section`, `*.toolbar.start/end`)
   must be present without importing any barrel.
2. **Hermeticity:** run the collector twice — once in a pristine checkout, once
   after deleting/altering `node_modules` and `auto-stubs.generated.ts` — and confirm
   byte-identical output. Because the collector never imports barrels, both must match.
   (This is the regression the bug is about: artifact presence must not change output.)
3. **Doc identity:** confirm the reorder `ConfigV2.WebRegister` count equals the
   manifest length (71) in both `docs/plugins-details.md` and `plugins/reorder/CLAUDE.md`
   after regeneration; `plugins-doc-in-sync` should pass.
4. **Check determinism:** `./equin check reorderable-slots-in-sync` and
   `plugins-doc-in-sync` must give the same verdict regardless of build artifacts.
5. Unit test from §4.5 (`bun test <path>`).

---

## 6. Coordination notes for Fix B

Fix B adds `generateReorderableSlots` (and data-views, token-group) to the push-time
normalize step `regen-generated`
(`plugins/framework/plugins/cli/bin/commands/regen-generated.ts`), which today only
runs `generateBarrelStubs / generatePluginRegistry / generatePluginDocs /
generateConfigOrigins` (`:32-35`) — it does **not** regenerate the manifest, so the
push-time `reorderable-slots-in-sync` check currently validates the committed file
against a *fresh runtime-walk scan* (non-deterministic).

**Interface Fix A exposes (stable, Fix B should call as-is):**
- `generateReorderableSlots({ root })` — writes the manifest; idempotent after Fix A
  because its scan is now pure. **Fix B adds this to `regen-generated`.**
- `renderReorderableSlotsManifest(root)` — pure render used by the in-sync check.
- Signatures unchanged; Fix A only changes the *internals* of
  `collectReorderableSlots` from live-walk to static.

**Ordering / shared-tree caveat:** today `generateReorderableSlots` is run AFTER
`generatePluginDocs` to reuse the cached `enrichedTreeCache`
(`build.ts:768-769`; cache in `docgen.ts:136-145`). After Fix A the manifest no
longer needs the *imported* tree — but it may still build a static tree. Fix B must
keep the same call ordering in `regen-generated` (docs → reorderable-slots →
data-views) so any shared cache stays warm; Fix A guarantees the result is identical
regardless of ordering, so ordering becomes a perf detail, not a correctness one.

**Shared file:** both fixes touch `reorderable-slots-gen.ts`
(Fix A: make the scan static; Fix B: nothing, it just calls the existing function)
and `regen-generated.ts` (Fix B edits; Fix A only depends on the function being
deterministic). Coordinate the merge so Fix B's `regen-generated` addition lands on
top of Fix A's deterministic scan — Fix B is correct only once Fix A makes the
re-run hermetic.
