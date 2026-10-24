# Composition entry patterns: a glob grammar for the closure engine

## Context

A composition (`plugins/plugin-meta/plugins/composition/core/config.ts`) declares
`entryPoints: PluginId[]`, and the closure resolver
(`plugins/plugin-meta/plugins/closure/core/resolve-composition.ts`,
`expandEntrySeeds`) seeds each entry **plus its entire subtree** (containment)
before taking the hard closure. This overloads one field with two intents and
resolves them differently depending on a hidden property of the target:

- Entrying a **no-runtime umbrella** (`apps.website`) is the *only* way to get a
  working app, because the umbrella imports nothing — its hard closure alone is
  empty, so the runtime-bearing children must be seeded by containment.
- But that same containment seeding **force-locks every descendant as
  `required`**, including soft-contributing children that the conservative
  opt-in model would otherwise leave as reviewable `available` options. Entrying
  an umbrella silently means "seed *and lock* the whole subtree."

The symptom is the `website` composition (`config.ts` ~163–184), which must list
**9 sub-plugin entries individually** to *avoid* pulling in `blog` and
`demos.editor-toy` — whose subtrees hard-import Pages / the block editor /
worktree infra. The additive-only manifest vocabulary has no way to say "this
umbrella except these branches," so the author had to hand-enumerate the subtree
minus two branches.

**Intended outcome.** Split the two intents into an explicit grammar. "Entry a
node" means *that node + its hard dependencies* — nothing more. Shipping a whole
subtree becomes an explicit opt-in (`.**`), and trimming a branch from a subtree
becomes expressible (`!`). This makes the mental model uniform (no
umbrella-vs-leaf special-casing) and lets `website` say what it means.

The long-term direction the user chose is **explicit-everywhere**: apps entry
their runtime `.shell` and explicitly select the sub-plugins they want, so soft
children are reviewable options rather than force-`required`. This plan builds
the engine that *enables* that model but **keeps `.**` on every existing seed for
backward compatibility** — the per-app explicit migration is deferred follow-up
(see "Deferred"). `website` is the one worked example that adopts the new
grammar now.

## The grammar

Dot-separated ids, with only a trailing `.**` and an optional leading `!`:

| Pattern | Seed contribution |
|---|---|
| `apps.deploy` | exact node only → `{apps.deploy}`. Its hard closure is added by `hardClosure` as always. **No implicit subtree** — the core semantic change. |
| `apps.deploy.**` | `{apps.deploy} ∪ subtree(apps.deploy)`. The old umbrella behavior, now explicit. |
| `!apps.website.blog` | negative, exact — removes `apps.website.blog` from *this composition's* seed set (subject to protection, below). |
| `!apps.website.blog.**` | negative, subtree — removes `{apps.website.blog} ∪ subtree(...)`. |

Deliberately **no** mid-glob (`apps.*`, `apps.**.foo`): only a whole-subtree
suffix and exact match. Trivial to match against `graph.subtree` keys, no
ambiguity, and it covers every real seed use. (Finer globs are a noted follow-up
if ever needed.)

`**` / `!` are not valid `PluginId` characters, but **nothing derives a
filesystem or config path from `entryPoints`** — paths come from the
composition's own plugin id. Keeping the field typed and casting at the config
boundary (as `manifest-map.ts:31` already does) is operationally safe. Introduce
a documentation alias `EntryPattern = string` in `closure/core/types.ts` and
re-type `CompositionManifest.entryPoints: EntryPattern[]` for honesty, with no
runtime brand (low churn; a branded `EntryPattern` is a follow-up).

## Resolution algorithm

New pure util `plugins/plugin-meta/plugins/closure/core/entry-pattern.ts`
(browser-safe, no fs/barrels — matches the rest of the engine):

```ts
export type EntryPattern = string;
export interface ParsedPattern { negate: boolean; base: PluginId; subtree: boolean; raw: string }
export function parseEntryPattern(p: string): ParsedPattern;      // strip leading '!', trailing '.**'
export function matchEntryPattern(p: ParsedPattern, graph: EdgeGraph): Set<PluginId>;
//   → {base} ∪ (p.subtree ? subtree(base) : ∅); unknown base ⇒ {base} inert (mirrors today's rule)
```

`expandEntrySeeds` (stays in `resolve-composition.ts`, imports the parser)
becomes:

```
expandEntrySeeds(entryPoints, graph): { seeds: Set<PluginId>; named: Set<PluginId> }

  seeds = ∅ ; named = ∅
  for p in positives (!negate):
    named.add(p.base)                              // exact bases of positive patterns
    for id in matchEntryPattern(p, graph): seeds.add(id)

  for n in negatives:
    for t in matchEntryPattern(n, graph):
      if named.has(t): continue                    // PROTECTED — never remove an explicit positive
      seeds.delete(t)

  return { seeds, named }
```

`resolveComposition` (`:73`) destructures `{ seeds: entrySeeds, named }`;
`required = hardClosure(entrySeeds)` and `bundle = hardClosure(entrySeeds ∪
selectedContributors)` are unchanged. The membership `entrySet` (`:97`) becomes
**`named`** (not `new Set(manifest.entryPoints)`), so a `.**` base classifies as
`entry` and its implicitly-pulled descendants stay `required` — preserving the
existing precedent (`apps.agent-manager.**` → `agent-manager`=`entry`,
`…shell`=`required`). `explain.ts:30` takes `.seeds` (its frontier is the
expanded seeds, as its comment already says).

### Why this upholds the load-bearing invariants

The system rests on *"override is inexpressible; resolution is a pure union /
hard-closure, no precedence"* (`composition/CLAUDE.md`, `closure/CLAUDE.md`). The
protection rule keeps that intact:

> A negative may only trim ids pulled in **implicitly by a `.**` glob**. It may
> never remove an id named exactly in the (flattened) `entryPoints`.

1. **Cannot silently sever a real dependency (fail-loud).** Negation only
   `seeds.delete()`s from the seed set. `bundle = hardClosure(entrySeeds ∪
   selectedContributors)` still walks `hardForward`. If any *kept* seed
   hard-*imports* something under a negated branch, `hardClosure` re-adds it — it
   ships. Negation prunes containment *seeding*, never import edges. (For
   `website`, nothing kept hard-imports `blog`/`editor-toy`; the taproots flow
   the other way — `editor-toy → … → infra.worktree` — so dropping them from the
   seed set is exactly what keeps worktree/Pages out, and the
   `excludes: ["agent-runtime"]` guard is the automated *proof* the taproot is
   gone.)

2. **Additivity survives — evaluate negatives POST-`flattenManifest`.**
   `flattenManifest` unions all `entryPoints` across the `extends` chain into one
   array *before* `expandEntrySeeds` (the `composition-closure` check already
   flattens before resolving — `check/index.ts:159`). If composition B `extends`
   A, A carries `apps.website.**` + `!…blog.**`, and B explicitly names
   `apps.website.blog.pages-integration`, then that positive lands in `named` and
   is shielded from A's negative. A positive from *anywhere* in the union wins
   over a negative from *anywhere*. Union-of-compositions stays a pure union.

3. **`selectedContributors` are protected structurally, not at the seed level.**
   The invariant lists them as protected — and they are, at the **bundle** level
   (`bundle` unions them regardless of the seed set, so a negative can never drop
   a selected contributor from the bundle). They are deliberately **not** added
   to `named`: doing so would keep a `.**`-implicit-and-selected id in
   `entrySeeds` → in `required` → in `redundantSelections`, tripping the check's
   "selects an already-required contributor" failure. Leaving them out of `named`
   lets such an id resolve cleanly as a `contributor` (a genuine soft option). This
   is the correct, conflict-free reading of the invariant.

## Exact edits

**New — `plugins/plugin-meta/plugins/closure/core/entry-pattern.ts`**
`EntryPattern` alias, `ParsedPattern`, `parseEntryPattern`, `matchEntryPattern`.

**`plugins/plugin-meta/plugins/closure/core/resolve-composition.ts`**
- Rewrite `expandEntrySeeds` (`:47–60`) to return `{ seeds, named }`; import the parser.
- `:73` destructure `{ seeds: entrySeeds, named }`.
- `:97` `const entrySet = named;` (drop `new Set(manifest.entryPoints)`).
- `:76/:80/:116–118` logic unchanged. Update the `:70–72` block comment to the new semantics.

**`plugins/plugin-meta/plugins/closure/core/explain.ts`** — `:30`
`const { seeds: entrySet } = expandEntrySeeds(manifest.entryPoints, graph);`.

**`plugins/plugin-meta/plugins/closure/core/types.ts`** — add `EntryPattern`;
re-type `CompositionManifest.entryPoints`; refresh the `entryPoints` / `subtree`
doc comments (`:31–36`, `:42–46`) to "entry = node + hard deps; subtree opt-in
via `.**`; `!` trims `.**`-implicit ids only."

**`plugins/plugin-meta/plugins/closure/core/index.ts`** — export
`parseEntryPattern`, `matchEntryPattern`, `expandEntrySeeds`, `EntryPattern` (the
check consumes them — single source of truth for pattern semantics).

**`plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts`**
- **Id resolution (`:130–138`):** parse each entry with `parseEntryPattern`;
  validate `allIds.has(parsed.base)` for every positive **and** negative base
  (reject 0-match bases). On the **flattened** manifest, additionally reject: a
  negative that trims **nothing** (dead negative) and a negative whose target is a
  `named` positive (contradictory no-op). A `.**` on a leaf (empty subtree) still
  matches its base ⇒ allowed.
- **`containmentOf` (`:204–211`):** replace the blind `id + subtree` loop over
  entries with the **same** `expandEntrySeeds(targetFlat.entryPoints, graph).seeds`
  (honors `.**` and negatives), then union each `selectedContributor` + its
  subtree as today. With every excluded bundle keeping `.**` on its entries,
  containment coverage is byte-identical to today. Update the `containmentOf`
  comment and the `closure/CLAUDE.md` "containment" description.

**Consumers that iterate entries as raw ids (must be pattern-aware):**
- `release.ts:269–271` — parse each entry, skip negatives, use `parsed.base` for
  `asFsPath(...)` (icon derivation), else migrated seeds like `apps.sonata.**`
  resolve to a non-existent node and throw.
- `store.ts:219` (`pinAsRoot`) — emit `entryPoints: [`${id}.**`]` so "pin as root"
  keeps whole-subtree closure (a bare id would now be hard-deps-only).
- `graph-view.tsx:41` — strip `active.entryPoints[0]` to `parseEntryPattern(...).base`
  before using it as a focus seed. (May ride with the deferred UI increment.)

**`plugins/plugin-meta/plugins/composition/core/config.ts` (backward-compat migration)**
Old `expandEntrySeeds` *always* added the subtree, so appending `.**` to every
existing entry reproduces every bundle byte-for-byte — **zero drift** for all
non-website compositions.
- `app()` helper (`:346–364`): `entryPoints: [entry + ".**"]`.
- `subsystem()` helper (`:367–379`): `entryPoints: entries.map((e) => e + ".**")`.
- `agent-manager` (`:75`) + `agent-manager-lean` (`:89`): `["apps.agent-manager.**"]`.
- `agent-runtime` (`:215–220`): each of the four entries → `.**`.
- **`website` (`:163–184`) — the payoff:**
  ```jsonc
  entryPoints: [
    "apps.website.**",
    "!apps.website.blog.**",
    "!apps.website.demos.editor-toy.**",
  ],
  ```
  keep `selectedContributors: ["apps.sonata.audio.piano"]`,
  `extends: ["served-baseline"]`, `excludes: ["agent-runtime","auth"]`. Rewrite the
  `:120–162` comment to explain the grammar (why `.**` minus negatives) and that
  `excludes: ["agent-runtime"]` is the automated proof `editor-toy`'s worktree
  taproot is gone. Resolves to the same bundle as today.

**Tests**
- `plugins/plugin-meta/plugins/closure/core/closure.test.ts` — migrate the
  fixture manifest (`:32–36`) to `["apps.agent-manager.**"]` (all existing
  assertions hold). Add: (i) bare `apps.agent-manager` seeds node + hard closure
  only, `shell` **not** bundled; (ii) `.**` seeds the subtree; (iii) synthetic
  negative trims a `.**`-implicit id but an explicit positive of the same id
  survives (additivity); (iv) synthetic negative on a branch whose kept sibling
  hard-imports into it still ships the imported id (fail-loud); (v) real-tree
  `website`-shaped manifest whose bundle excludes every `apps.website.blog.*` and
  `apps.website.demos.editor-toy.*` id and includes
  `apps.website.demos.app-gallery`/`shell`/`landing`.
- `plugins/plugin-meta/plugins/composition/core/config.test.ts` — replace the
  `website` test's raw-`entryPoints` `startsWith("apps.website.blog")` guard
  (`:82–97`) with a grammar assertion (entryPoints include the `.**` + two
  negatives); move the "blog/editor-toy absent from bundle" regression into
  `closure.test.ts` (which has the tree). Update `agent-runtime`'s
  `toContain("infra.worktree")` expectations (`:70–80`) to the `.**` forms.

## Deferred (follow-ups, not in this plan)

- **Explicit-everywhere per-app migration.** Convert each app seed from
  `apps.foo.**` to `apps.foo.shell` (bare) + a curated `selectedContributors`
  list, so soft children become reviewable `available` options instead of
  force-`required`. Best done one small PR per app; the grammar here unblocks it.
- **Studio entry-points editor UI**
  (`plugins/apps/plugins/studio/plugins/compositions/plugins/entry-points/web/`).
  `shortName()` and the chip list assume a plugin id; they must render
  `apps.website.**` and `!…blog.**` (subtree / negative affordances) and split
  positive vs. negative groups. The add-search needs three actions per hit (add
  exact / add `.**` / add `!…**`), offering a negative only for an id currently
  pulled in implicitly by an existing `.**`. Raw `config_v2` editing carries this
  meanwhile.
- Branded `EntryPattern` type; finer glob syntax.

## Verification

- **Unit:** `bun test plugins/plugin-meta/plugins/closure/core/closure.test.ts`
  and `bun test plugins/plugin-meta/plugins/composition/core/config.test.ts`
  (both pure — no server/DB). The new cases (iii)/(iv) prove additivity and
  fail-loud; (v) proves `website` drops blog/editor-toy.
- **Check:** `./equin check composition-closure` (reads the committed
  git-layer config off disk). Because the migration is bundle-preserving, every
  existing composition still passes its redundant / soft-option / `excludes`
  gates; `website`'s `excludes: ["agent-runtime"]` disjointness is the live proof
  the negatives dropped the `editor-toy → … → infra.worktree` taproot. Confirm the
  new negative-validation rejects a deliberately-broken seed (`!…blog.**` with no
  matching `.**` positive → "matches nothing").
- **Build + eyeball:** `./equin build`, then open
  `http://<worktree>.localhost:9000/studio/compositions/comp/website`. Confirm the
  Closure section tints `apps.website.blog.*` and `apps.website.demos.editor-toy.*`
  as `excluded`/`available` (not bundled), the sonata `piano` path and
  `demos.app-gallery` are present, and the Membership summary shows **no**
  force-`required` children under the negated branches. Compare against
  `agent-manager` (`entry` = `agent-manager`, `required` = `…shell`, unchanged).
  Spot-check `pinAsRoot` in the graph pane still expands a whole subtree after the
  `store.ts` `.**` edit.

## Critical files

- `plugins/plugin-meta/plugins/closure/core/entry-pattern.ts` (new)
- `plugins/plugin-meta/plugins/closure/core/resolve-composition.ts`
- `plugins/plugin-meta/plugins/closure/core/explain.ts`
- `plugins/plugin-meta/plugins/closure/core/types.ts` · `index.ts`
- `plugins/plugin-meta/plugins/composition/core/config.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts`
- `plugins/plugin-meta/plugins/closure/core/closure.test.ts` ·
  `plugins/plugin-meta/plugins/composition/core/config.test.ts`
- Pattern-aware consumers: `release.ts`, `store.ts`, `graph-view.tsx`
