# plugin-boundaries

Implements the plugin-structure rules (R1–R13) enforced by
`./equin check plugin-boundaries`. The rule grammar is summarized in the
root `CLAUDE.md` → "Plugin boundary rules".

This check does **not** decide which folder may import which. That is
`boundary-rules` (`tooling/boundaries`), which applies one `folders` table to
every import, relative ones inside a plugin included, and also owns "every file
sits in a known folder" and "only test code and `check/` may import test code".
What this check owns:

| Rule | Id | What it fails |
| --- | --- | --- |
| R1 | `package` | a plugin's `package.json` `"name"` out of sync with its path |
| R3 | `barrel-required`, `barrel-purity`, `cross-plugin-reexport` | a runtime folder (or a `<runtime>/testing/` holding TypeScript) with no `index.ts`; logic in a barrel; a barrel surfacing another plugin's name |
| R4 | `grammar` | a cross-plugin specifier that ends anywhere but `<runtime>` or `<runtime>/testing` |
| R5 | `default-import` | a plugin's default export imported outside the registry roots |
| R6 | `cycle` | a cycle in the cross-plugin import graph (per runtime) |
| R7 | `workspace-import` | an `@equin/plugin-*` specifier |
| R8 | `relative-cross-plugin` | a relative path escaping into another plugin |
| R9 | `inline-import` | an inline `import("…")` type expression targeting a barrel |
| R10 | `cross-plugin-internal`, `shared-use-relative` | another plugin's `shared/`; your own `shared/` via the `@plugins` alias instead of a relative path |
| R11 | `unknown-dir` | a top-level directory in a plugin that is not a plugin folder |
| R12 | `test-support-in-public-barrel` | test support published from a public barrel |
| R13 | `test-only-public-export` | a public barrel name whose every importer is test code |

R4–R10 look only at imports that cross a plugin boundary (R10's
`shared-use-relative` is the one intra-plugin case); inside a plugin, deep paths
are fine, and the folder rows are `boundary-rules`' job.

## Package name (R1) is generated, R1 only guards it

A plugin's `package.json` `"name"` is a pure function of its path —
`packageNameFor` in `plugins/framework/plugins/plugin-id/core`
(`@equin/plugin-<every non-plugins segment, joined with ->`). Nothing reads
it, but bun needs it. The repo-tree codegen (`syncPluginPackageNames` in
`plugins/framework/plugins/tooling/plugins/codegen/core/package-names.ts`, the
first step of `regenerateRegistryCodegen`) writes it on every
`./equin build` / `./equin regen-generated`, touching only that one
value. R1 is the in-sync guard, the same role `plugins-registry-in-sync` plays
for the registries: a stale name is fixed by running the build, never by hand.
Composition roots are skipped by both. A plugin with no `package.json` at all is
still R1's to report — the build does not create one.

Because `bun.lock` records every workspace member's name, a build that corrects
a name re-resolves dependencies right after (`ensureDeps`), so the lockfile
lands with it.

## Testing barrels

A runtime folder may publish test helpers from `<runtime>/testing/index.ts`.
R4 accepts `@plugins/<p>/<runtime>/testing` as a legal ending; R3 requires the
`index.ts` once `testing/` holds TypeScript and applies barrel purity and the
cross-plugin re-export rule to it. Who may import a testing barrel (test code
and `check/` only) is `boundary-rules`' job, not this check's.

R12 (`test-support-in-public-barrel`, `check/test-exports.ts`) is the other
direction: a public runtime barrel may not publish test support. It fails on a
published name ending in `ForTest`/`ForTests`/`ForTesting`, and on a statement
taking names from a test-support module — a test-code path (`testing/`,
`__tests__/`, `*.test.ts`) or a file named `test-support`, `fixture(s)` or
`<x>.fixture(s)`. The fix is to publish it from `<runtime>/testing/index.ts`.
A reset hook keeps its body next to the state it resets; only the export moves.

R13 (`test-only-public-export`, `check/test-only-exports.ts`) asks who imports
each name a public barrel publishes. A name whose importers are all test code
fails: nothing that ships needs it, so it is not API. A name nothing imports is
left alone (that is dead code, a different question), and `check/` / `lint/`
importers count as shipping code. The uses are collected in the same per-file
loop as R4–R10, so the check reads no extra files. A `@plugins/…/<runtime>`
specifier or a relative path landing on `<runtime>/index` both count; an
aliased import counts under the barrel's name; `export { x } from` counts as a
use. A namespace import from shipping code uses every name; one from a test
(the `vi.mock(importOriginal)` idiom) uses none. There are two fixes. The
plugin's own test imports the internal file by relative path. When another
plugin's test needs the name, whether a helper or a real function it checks
against, the name is published from `<runtime>/testing/` (a testing barrel
may re-export a real function). A test moves only when it tests nothing of
its own plugin. There is no allowlist.

## Cross-plugin re-export (provenance-based)

The `cross-plugin-reexport` rule is **name-level and transitive**, not a
surface-syntax scan of the barrel. For every name a barrel actually *surfaces*,
it resolves the name back to its origin plugin and flags any whose origin
differs from the barrel's own plugin — there is **no umbrella/parent→descendant
carve-out**. The resolver (`check/reexport-provenance.ts`) follows three shapes,
at any depth, through the plugin's own internal files:

- **Direct**: `export { X } from "@plugins/other/<runtime>"` in the barrel.
- **Indirect chain**: `export { X } from "./internal"` where `./internal`
  (re-)exports `X` from another plugin. Relative hops are followed only while
  they stay inside the plugin; a relative path escaping into another plugin is
  R8's job (`relative-cross-plugin`), so the resolver stops there.
- **Import-then-reexport**: `import { X } from "@plugins/other/<runtime>"; export { X };`
  (the bare `export { X }` carries no `from`), in the barrel or any surfaced
  internal file.

Because it is name-level, an internal file that re-exports a foreign symbol the
barrel does **not** surface is correctly *not* flagged. To fix a real violation,
import the foreign symbol from its source barrel at each consumer — never proxy
it. There is no re-export exemption.

## The file set comes from git, never from a filesystem walk

Every question this check asks about what exists — which sources to parse
(`check/source-files.ts`), which subdirectories a plugin has and whether one
holds TypeScript (`check/repo-tree.ts`, feeding R11 and R3's `barrel-required`)
— is answered from **one** `listRepoFiles` call per run, made at the top of
`run()` and threaded down.

That is a correctness requirement, not a tidiness one. The check is
`inputKeyed`, and its read-set records membership as `view.glob("plugins/**")`
over the git **tree snapshot** (`check/read-set.ts`). A `readdirSync` walk
answers a different question: it also sees gitignored files. So a stray `.ts`
under a gitignored directory inside `plugins/` used to be scanned for violations
— and could raise a real `unknown-dir` or `barrel-required` failure — from
content no commit contains and the cache key does not cover. Both walks and
their partial `node_modules` / `dist` deny-lists are gone; `.gitignore` is the
one place that decides, and it is the same place the cache key reads.

A directory therefore means "holds at least one git-listed file". An empty
directory, or one holding only gitignored files, is invisible — which is the
answer R11 already wanted, since it only ever flagged directories containing
TypeScript. The one exclusion that is about **meaning** rather than about
ignoring build output stays explicit in the rule: a dot-directory is not a claim
to be a zone, and `.claude/` is tracked, so gitignore would not hide it.

See [`research/2026-09-09-tooling-check-file-enumeration-from-git.md`](../../../../../../../../research/2026-09-09-tooling-check-file-enumeration-from-git.md).

## Asset imports (R4 exemption)

A cross-plugin **side-effect import of a non-JS asset** (a `.css` stylesheet,
font, or image — see `ASSET_EXTENSIONS`) is exempt from the barrel-grammar rule
(R4). An asset is not a JS module and exposes no exportable symbol, so it cannot
be re-exported through a plugin's `index.ts` barrel — it is referenced by its
real path (e.g. the SPA entry
`import "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css"`). The DAG edge is
still tracked (R6), so a *cyclic* asset dependency is still caught.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Exemptions:
  - Exempts itself from: `marker-scan-safety/no-adhoc-marker-scan` — `check/parse.ts` (sanctioned)
  - Exempted by: `framework/web-core` (0 debt)

<!-- AUTOGENERATED:END -->
