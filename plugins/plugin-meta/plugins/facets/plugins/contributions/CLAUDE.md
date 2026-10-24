# contributions

Extracts runtime slot contributions from each plugin's barrel imports. Reads
`def.contributions[]` from the module default export across all runtimes (in
practice only web barrels carry contributions).

Unlike static-analysis facets (commands, slots, resources), this facet needs the barrel-imported
modules — it reads the `imported` field of `ExtractContext`, which is populated by
`buildPluginTree()` when `skipBarrelImport` is not set. That field carries the modules and the
`SlotNaming` of the declaration pass over those same modules as ONE value, and the pairing is the
point: a plugin's `contributions` array is not always a literal (reorder's is filled by a
`subscribeSlotsDeclared` callback), and reading barrels without a pass answers with a smaller set
indistinguishable from a correct one — which is how a `docs/plugins-details.md` missing reorder's
whole `Contributes:` block once shipped. Slot ids come from `naming.idOf(c._slot)`, never from the
process-global stamps, so this facet's answer cannot depend on what else ran beside it.

## Pane ids are a join, not a local read

A `Pane.Register` contribution names a pane *variable*; the surfaces want the
pane's **id**, and that id is usually not a local fact. `Pane.define({ route })`
carries no id of its own — it is on the `defineRoute()` behind the `route:`. When
that route is a hoisted binding the id lives wherever the binding does, which for
7 of the first 22 converted panes was a *different* plugin's `core/`. Nor was it
local before routes: `apps/settings/accounts` registers `accountsPane` imported
from `@plugins/auth/web`, and showed no id for years. The one local case is an
INLINE `route: defineRoute({ id })`, where the route has no binding to look up
and the whole identity sits on the pane declaration.

So `extract()` records only what one plugin's own files say — `routes` (its
`defineRoute()`s, across `core/`/`shared/`/`web/`), `panes` (its `web/`
`Pane.define()`s: a `route:` naming a hoisted binding is recorded as a
*reference* for `relate()` to resolve, while a `route:` holding an inline
`defineRoute` has its literal id read straight off), and `paneRefs` (the barrel's
imports of the pane variables it registers). `relate()` follows those hops with
the whole tree in scope, resolving a specifier via `resolvePluginSpecifier`; a
relative specifier can only mean the referring plugin itself, since relative
escapes into another plugin's tree are forbidden.

Three rules the scanners must keep:

- **Read `route:` at depth 0** of the call body. A pane body nests objects
  (`title: { text }`, `options: { … }`) spelling the very same key, and a
  first-match-at-any-depth read takes one of those as the identity, silently.
  The inline arm matches its `defineRoute` call by exact offset for the same
  reason — an `options: { route: defineRoute(…) }` decoy is a real call too.
- **Never read identity off the imported pane object** (`pane._internal.id`, which
  is public and tempting). All three surfaces this facet feeds build their tree
  with `skipBarrelImport: true`, so the runtime half is empty exactly there.
- **A `Pane.define` whose identity cannot be read THROWS**, rather than being
  dropped. Dropping it is invisible: `docs/plugins-details.md` takes its pane
  lines from the runtime `docLabel`, so `plugins-doc-in-sync` stays green while
  the Studio table, the plugin-detail card and the PR diff all lose the id. The
  two readable spellings are a bare `route:` identifier (declared in the file or
  named-imported into it) and an inline `route: defineRoute({ id: "…" })` whose
  id is a literal string. A `Pane.define` written inside a string, a template
  literal or a comment is masked away before the scan and never reaches this
  rule.

`extract()` collects `{ slotId, componentName, doc }` without display names.
`relate()` fills in `slotDisplayName` by reading from the slots facet —
`${groupName}.${memberName}` from each `SlotDef` — resolves each `Pane.Register`
to its `paneId` (above), links each static contribution to its slot definer
(`definerPluginId`), and populates the **slots facet's** per-slot reverse index
(`SlotDef.contributors`, the full plugin ids that contribute to each slot). That
last write lives here, not on the slots
facet, because the join needs both facets in scope and the reverse import edge
would close a collected-dir dependency cycle.

`renderDoc()` prints one line per contribution, grouped by slot (a grouped
`DocFact`), so docgen can summarize a long list as one count per slot
(`` `ConfigV2.Register` ×226 ``) and list it in full in the plugin's
`REFERENCE.md`. A group of label-only entries (a `doc.label`, no `doc.detail`,
no `componentName`) is a set and is printed **sorted**, because the array order
behind it is a runtime declaration order that varies between processes — left
unsorted it would make the generated doc depend on process history rather than
on the checkout, so `plugins-doc-in-sync` would pass alone and fail in a full
run. Groups keep their first member's position, and other groups their original
order, so the regenerated doc's diff stays honest.

Browser rendering lives in the `render-diff` / `render-detail` / `render-catalog`
sub-plugins, each reading `node.facets["contributions"]` and contributing to an
existing web slot. The diff projection (`contributionsToComparable`) and the
shared `contributionId` helper live in `core/`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Core:
  - Uses: `plugin-meta/facets.defineFacet`
  - Exports (types):
    - `Contribution`
    - `ContributionsFacetData`
    - `DocMetaContribution`
    - `PaneDeclaration`
    - `RouteDeclaration`
    - `ServerCompanionContribution`
    - `ServerCompanionKind`
    - `SourceRef`
  - Exports (values):
    - `contributionId`
    - `contributionsFacetDef`
    - `contributionsToComparable`
- Cross-plugin:
  - Imported by:
    - `framework/tooling/codegen`
    - `plugin-meta/closure`
- Sub-plugins:
  - **`render-contributions`** — Aggregated cross-plugin contributions table in the Studio Contributions view.
  - **`render-detail`** — Per-plugin contributions section in the plugin detail pane.
  - **`render-diff`** (excluded — cascade) — Diff renderer for the contributions facet (PR review).

<!-- AUTOGENERATED:END -->
