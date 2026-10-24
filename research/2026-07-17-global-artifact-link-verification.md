# Compose-time link verification for web artifacts

## Context

Artifact mode has been the default frontend build since 2026-07-16
(`research/2026-07-15-global-per-plugin-web-artifacts.md`). Its central trade —
the one that makes builds O(changed plugins) — is that **cross-plugin imports
stay external**: plugin A's artifact emits `import { X } from "@plugins/B/web"`
verbatim and the import map binds it in the browser. A's hash deliberately does
not include B's contents; that late binding is what makes rebuilds
cascade-free.

The cost of that trade is a lost guarantee. Under the monolithic Rollup build,
renaming or deleting `X` from B failed A's build at bundle time. Today it
fails nowhere at build time and surfaces in the browser as:

```
SyntaxError: The requested module '/artifacts/b.web.<hash>/index.js'
does not provide an export named 'X'
```

`type-check` compensates on normal builds and on `push`, but it is neither
complete nor always present:

- **`--skip-checks` runs no web-side validation at all.** Compose is the only
  thing standing between a broken link and a deployed dist.
- **Types lie.** `as` casts, a stale `.d.ts`, value-vs-type drift, and
  `declare` shims all typecheck green while the emitted bytes disagree.
- **The failure is fleet-wide by construction.** B changes; A is reused from
  the store unrebuilt and unexamined. Nothing ever re-reads A against the new B.

**Goal:** restore the monolith's bundle-time linkage guarantee — and exceed it,
since this verifies the *emitted bytes* of the whole composed fleet, not one
bundler's module graph.

**Decisions made with the user (2026-07-17):**

- **Scope: all staged links**, `@plugins/*` barrels *and* npm vendor artifacts.
  The Phase-1 CJS-interop bug (`@tonejs/midi` named exports destructured from an
  `undefined` interop default) was exactly a vendor link — this would have
  caught it at compose instead of in the browser.
- **Policy: hard-fail** at compose, consistent with the existing
  unresolvable-specifier behavior. `--monolith` remains the escape hatch; no new
  bypass flag.

## Where this lives, and why

**`core/internal/staged-verify.ts` (`scanStagedModules`) — extend it, don't add
a new pass.** It is already the exact specifier-resolution twin of what's needed:

- It runs inside **compose stage 5** (`core/internal/pipeline.ts:283`), i.e. on
  every build regardless of `--skip-checks`. That is precisely the gap.
- It already walks every staged `.js`/`.mjs` under `<stagingDir>/artifacts/` and
  already hard-fails on unresolvable specifiers.
- **The export lists are already computed and discarded.** `staged-verify.ts:56`
  reads `const [imports] = esLexerParse(...)`; es-module-lexer returns
  `[imports, exports]`. The marginal cost is one extra in-memory pass — no extra
  file I/O, no new dependency.
- It reads staged bytes rather than planner metadata, preserving the plugin's
  stated invariant: *"Ground truth is verified independently of the planner."*
  This matters — `meta.json` records **specifiers only, not named bindings**
  (`store.ts:32-47`), so the names must come from the bytes regardless.

A `check/` was rejected: checks are skippable, and this must not be.

## Design

### Pass 1 — extend the existing per-file loop

For each staged `.js`/`.mjs`, keep both halves of the existing parse:

```ts
const [imports, exports] = esLexerParse(src, distRel);
```

Record per file: its own export names (`exports[].n`), whether it contains an
emitted `export *` (see "opaque targets"), and for each **static** import the
clause parsed from `src.slice(imp.ss, imp.s)`.

### Clause parsing — a pure, unit-tested helper

New `core/internal/import-clause.ts` + co-located `import-clause.test.ts`:

```ts
parseImportClause(text: string): {
  isReexport: boolean;    // the text begins with `export`
  namespace: boolean;     // `* as ns`
  star: boolean;          // `export * from`
  hasDefault: boolean;
  names: string[];        // named bindings, LOCAL alias discarded
}
```

Measured against the real fleet: **91 distinct clause shapes, none containing
comments, newlines, or string-literal names**, single-line under both
minify-on (`import{a as s}from"…"`) and `--no-minify`. `slice(ss, s)` is
reliable here.

**The one trap that must be guarded (verified, latent today):**
es-module-lexer reports `export { A } from "x"` **in the imports array with
`d === -1`** — indistinguishable from a real import by any field. A parser that
takes the leading identifier before `{` as the default binding reads the word
**`export` itself as a default import**, inventing a phantom `default`
requirement — a false positive. Hence `isReexport` is checked *first*, before
the default-identifier heuristic. This is latent (0 occurrences fleet-wide) but
reachable: `buildRegistryArtifact` uses `esbuild.transform`, not `build`
(`vite-builder.ts:258`) — the registry codegen passes through unbundled, so one
codegen change to `export {…} from` lights it up.

### Resolution — specifier to staged file

- Bare → `opts.imports[spec]` → URL → dist-relative path via `url.slice(1)`.
  Verified safe: all 1,010 map entries are exact file URLs under `/artifacts/`;
  `buildImportMap` emits nothing else (`plan.ts:288-297`).
- Relative → `resolve(dirname(abs), spec)`.
- Unresolvable → already reported by the existing specifier check; skip the name
  check (never double-report).

### Pass 2 — the link join

For each recorded static import: resolve the target, then assert every imported
name (plus `"default"` when `hasDefault`) is in the target's export set. A miss
is a **link failure**.

**No transitive `export *` union, no cycle guard, no memoization.** The fleet
emits **zero `export *`** — the `export * from "@tanstack/query-core"` that
appears in `vendors.ts:202` is *wrapper source consumed by esbuild's bundler*
(`bundle: true`), and never reaches emitted output. Building a transitive star
resolver would be substantial complexity for zero instances, and — worse — it
would masquerade as a false-positive escape hatch that can never actually fire.

Instead, a 3-line **opaque-target guard**: if a target file contains an emitted
`export *`, its export set is incomplete, so links into it are *not verified*
and a loud warning names the file. Sound (no false positives), not silent, and
it converts a future builder/vendor-design change from a fleet-wide false
failure into a visible line of output.

### Skips (never reported — each semantically correct)

- **`import * as ns`** — member access is dynamic; `ns.Missing` is `undefined`
  (a TypeError, not a link error). Only 3 in the dist. The browser doesn't
  enforce it either, so neither should we.
- **Dynamic `import()`** — names aren't statically knowable.
- **Opaque targets** — see above.

### The one cheap gap worth closing: web barrels must export `default`

The registry's loaders are typed `() => Promise<{ default: unknown }>`
(`web.generated.ts:11`) and are **dynamic** imports — skipped by name
verification. A web barrel that loses its default export is `undefined` at
runtime: a TypeError that *nothing* currently catches.

Derive it from the import map alone (no new plumbing, still ground-truth): for
each `[spec, url]` in `opts.imports` where `spec` starts with `@plugins/` and
ends with `/web`, assert `default ∈ exportsOf(url)`. All 714 web artifacts
satisfy this today, so it lands green.

### Failure output

Extend `StagedScanResult` with `linkFailures: Array<{ specifier; name; file }>`
and throw from the same site in `pipeline.ts` (alongside the existing
`failures` throw), with an actionable message:

```
compose: 2 staged import(s) do not link:
  "@plugins/tasks/web" does not export "TaskRow"  (imported by artifacts/foo.web.ab12/index.js)
```

## Empirical grounding

The design was implemented and run against all 5 live dists before writing this:

| Metric | Result |
| --- | --- |
| Files scanned / named links / names checked | 1,414 / 8,041 / 14,080 |
| **False positives** | **0** |
| `default` imports verified | 349 (all clean) |
| Specifiers unresolved | 0 |
| `export *` in emitted output (store + vendors, 11,037 files) | **0** |
| `import * as ns` skipped | 3 (dist) |
| Map URLs outside `/artifacts/`, non-file, or directory | 0 / 0 / 0 |
| Web artifacts exporting `default` | 714 / 714 |

Non-vacuous and clean. Other false-positive sources checked and cleared:
sourcemaps are excluded correctly (`"index.js.map".endsWith(".js")` is false),
`public/` is copied to the staging **root**, not `artifacts/` (`compose.ts:70`),
the CSS-injection snippet is plain JS appended after the module
(`vite-builder.ts:214`) and parses clean, and 104 `.mjs` chunks scan clean.

**Vendors are a source of true positives, not false ones.** If `cjsNamedExports`
under-reports (incl. the bare-re-export bail at `vendors.ts:136`), the wrapper
omits the name, the vendor entry *genuinely* lacks that export, and the browser
*genuinely* throws. Same for `moduleFormatOf` misclassification. Notably 56 of
71 vendor entries legitimately have no `default` export and are handled
correctly by `esmHasDefaultExport` (`vendors.ts:153`).

## Files

- `core/internal/staged-verify.ts` — keep `exports` from the existing parse;
  record clauses; add pass 2 + the web-barrel `default` assertion.
- `core/internal/import-clause.ts` **(new)** — pure clause parser.
- `core/internal/import-clause.test.ts` **(new)** — the 91 real shapes, the
  `export {…} from` phantom-default trap, `export * as ns`, `import X, * as ns`,
  `import {}`, `import { default as X }`.
- `core/internal/staged-verify.test.ts` — extend: a missing named export fails;
  a namespace/dynamic import does not; an opaque target warns and does not fail;
  a web barrel without `default` fails.
- `core/internal/pipeline.ts` (~283-299) — throw on `linkFailures`, log opaque
  warnings.
- `CLAUDE.md` — fold link verification into the "Every emitted external import
  must resolve" invariant.
- `research/2026-07-15-global-per-plugin-web-artifacts.md` — append the outcome.

## Costs (accepted)

- **A full fleet rebuild, once per host (~150s).** `staged-verify.ts` lives
  under `core/`, and `builderSourceDigest` (`identity.ts:48`) hashes this
  plugin's whole `core/` source into every artifact's `inputsHash`. Editing it
  invalidates all ~924 artifacts even though not one artifact's bytes change.
  This is the "builder edits auto-invalidate the fleet" guarantee working as
  designed; narrowing the digest to exclude verification-only files would trade
  a real structural guarantee for a one-time 150s. Not worth it.
- **Compose gains one in-memory pass.** No new file reads, no new dependency, no
  cache. A cache was considered and rejected: link validity is *pairwise*
  (importer × target), not intrinsic to one content-addressed artifact, so the
  `vendored-scan.json` precedent doesn't transfer — and the scan it would avoid
  is already being paid.

## Verification

1. **Green on the real fleet:** `./equin build` — compose reports 0 link
   failures, 0 opaque warnings; build succeeds and the app boots with 0 console
   errors (`e2e/screenshot.mjs` over tasks / pages).
2. **Break-glass (the actual gate):** rename an export in a low-fanout barrel
   without touching its importer, rebuild, and confirm compose hard-fails naming
   the specifier, the missing name, and the importing artifact — where today the
   build passes and the browser throws `SyntaxError`. Restore and confirm green.
3. **`--skip-checks` still catches it:** repeat (2) with
   `./equin build --skip-checks` — this is the hole being closed, so it
   must fail there too.
4. **No false positives fleet-wide:** the run in (1) covers 8,041 links /
   14,080 names across every artifact.
5. **Unit tests:** `bun test plugins/framework/plugins/tooling/plugins/web-artifacts`
   (54 existing pass + the new clause/link cases).
6. `./equin check` exit 0; `--monolith` build unaffected.

## Outcome (2026-07-17)

Landed and verified. `core/internal/import-clause.ts` (pure parser) +
`staged-verify.ts` (pass 1 keeps `exports`; pass 2 link join; opaque guard;
web-barrel `default` assertion) + `pipeline.ts` throw. 82 tests pass (the
existing baseline was **58**, not 54 as this doc originally claimed).

**Clean on the real fleet:** `./equin build` — 940 built / 0 reused (the
predicted `builderSourceDigest` fleet invalidation, 331s), **941 links composed,
0 link failures, 0 opaque warnings**, all checks green, deployed.

**Gate proven to fire on real composed bytes.** Poisoning a copy of the deployed
dist (dereferenced, shared store untouched) to drop `formatRelativeTime` from
`primitives/relative-time/web`'s emitted export list:

```
specifier failures : 0        ← the pre-existing check is BLIND to this
opaque targets     : 0
LINK FAILURES      : 4
  "@plugins/primitives/plugins/relative-time/web" does not export "formatRelativeTime"
    (imported by artifacts/apps.sonata.library.web.…/index.js)   … ×4
```

Exactly the 4 artifacts that bind that name in emitted bytes — no false
negatives — while the **other 32 artifacts importing the same barrel** (they
bind `RelativeTime`) were correctly untouched, and the other 940 artifacts
produced zero false positives. `debug/profiling/runtime` imports it in *source*
but not in emitted bytes (tree-shaken) and was correctly not flagged — a
concrete illustration of why byte-level truth beats source-level scanning.

### The premise of this doc was partly wrong: docgen already gates source-level renames

The break-glass test intended to prove the compose gate end-to-end through the
real build **failed to reach compose**. Renaming a barrel export and running
`./equin build --skip-checks` aborts *earlier*, in the docgen step:

```
error: [barrel-import] Failed to import …/sonata/plugins/library/web/index.ts:
Export named 'formatRelativeTime' not found in module …/relative-time/web/index.ts
```

`buildPluginTree` (`plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`
~L352-366) imports **every** plugin's `web`/`server`/`central` barrel through
Bun's real ESM loader, which link-checks the whole transitive **source** graph —
on every build, and *not* skippable by `--skip-checks`. So the headline scenario
in this doc's Context ("renamed export in B surfaces only as a browser
SyntaxError") was **already caught at build time**, by docgen rather than by
`type-check`. Neither the original task framing nor this plan knew that.

### The real value: the builder-rewrite divergence class (proven)

docgen and `type-check` both verify the **source** graph. Neither can see a
divergence *introduced by the builder itself* between source and emitted bytes.
The load-bearing instance is the **own-core rewrite** (`ownCoreBarrelPlugin`,
`vite-builder.ts:55-90`): every own-core import — barrel, deep relative
(`../core/resources`), or deep alias — is rewritten to the external
`@plugins/<path>/core` barrel specifier, preserving the named bindings. Its own
docstring states the consequence plainly:

> a deep import of a symbol the core barrel does not re-export fails LOUDLY as a
> missing-export error **at load**

*At load* means in the browser. Nothing catches it at build time, because the
source is legitimately valid — the deep path really does export the symbol. This
is not hypothetical: Phase 1 hit it twice (`conversations/agents`,
`primitives/log-channels` both needed barrel additions), and deep own-core
imports are routine (`bookmarks/web/index.ts` re-exports from
`../core/resources` today).

**Demonstrated end-to-end.** Adding `export const __probeSymbol = 1` to
`bookmarks/core/resources.ts` (a file the core barrel does NOT re-export from
wholesale) and deep-importing it from `bookmarks/web/index.ts` — a change whose
source is entirely valid — then `./equin build --skip-checks`:

```
── web artifacts ✗ (72.3s)
│ Error: compose: 1 staged import(s) do not link (ground-truth scan of the staged dist):
│   "@plugins/apps/plugins/browser/plugins/bookmarks/core" does not export "__probeSymbol"
│     (imported by artifacts/apps.browser.bookmarks.web.f8274babfdf92936/index.js)

  checks (always-run) ✓   tsc central-core ✓   tsc cli ✓   tsc server-core ✓   web artifacts ✗
  NOT DEPLOYED.
```

**docgen ✓, type-check ✓, compose ✗.** Every pre-existing gate passed; only this
one caught it. Without it the build is green and the browser throws
`SyntaxError` at load — findable only by a human opening the app.

**Also uniquely covered** (same reason — deployed bytes, not source):

- **Vendor wrappers** — docgen imports the real npm package from `node_modules`,
  which *has* the export; the vendor *artifact's* generated wrapper may not
  (`cjsNamedExports` under-reporting, `vendors.ts:136`). NB: this is a *sibling*
  of the Phase-1 `@tonejs/midi` bug, not the same one — that bug exported the
  name with an `undefined` *value* (a TypeError), which link verification cannot
  see. Neither Phase-1 bug would have been caught by this gate.
- **Stale or poisoned store artifacts** — the "store poisoning/staleness" risk
  the Phase-1 doc lists. Content-addressing is *assumed* correct; nothing else
  ever re-reads the deployed bytes.
- **Tree-shaking / minifier / builder bugs** that drop an emitted export.
- **Graph regions docgen never imports**: non-barrel folder kinds (`fixtures`),
  vendor entries, anything behind `registerBarrelStubs`.

### Scope correction

The task's headline framing ("a renamed export in B") is **already covered** by
docgen. The genuine value is one layer down: **this gate guards the builder, not
the source** — the rewrite/vendor/tree-shake/store layer that stands between
valid source and deployed bytes, and which no other gate inspects. Note also
that docgen's link check is an *accident* of importing barrels for facet
extraction, not a designed gate; if docgen ever moves to static parsing (a
plausible perf change — it is a known build cost), that coverage vanishes
silently. This gate is explicit.

Ongoing cost is ~one in-memory pass; the one-time cost was the 331s fleet
rebuild.

## Follow-ups (not in scope)

- Import maps prefix-match keys ending in `/`; `spec in opts.imports` is
  exact-key. None exist today and a miss fails toward *skip*, not a false
  failure — safe direction, worth a guard if trailing-slash keys are ever added.
- `import * as ns` member access could in principle be checked via property
  regex — brittle, and the browser doesn't enforce it either. Deliberately not
  done.
