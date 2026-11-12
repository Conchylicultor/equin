# investigate:failures-registered on source-analysis

## Context

`investigate:failures-registered` (`plugins/primitives/plugins/launch/plugins/investigate/check`)
holds every listed `liveCollection` / `liveArm` whose fields carry a
`variant: "destructive"` option to an `Investigate.Register({ owner })`. It
reads code with regexes over masked text: the tint by `variant:\s*["']destructive["']`,
declarations by `liveCollection(`, registrations by `Investigate.Register(`
text, constants by a `const x =` regex and imports by a hand-rolled
`importAliases`. It misses `variant: DESTRUCTIVE`, spreads, a re-aliased
namespace / `export * as`, and over-tints by NAME across files (a same-named
constant anywhere counts). Follow-up of the shared analysis landed in
`checks/plugins/source-analysis` (`research/2026-11-12-global-check-source-analysis.md`).

## Higher rungs, rejected

- **Inexpressible / type error.** The tint lives in field option meta typed
  `variant?: BadgeVariant` (`fields/core`), reached through shared, widened
  constants (`RUN_OUTCOME_OPTIONS_META`, entity fields via `from:`), so
  `liveCollection`'s generics cannot see a literal `"destructive"` — a type rule
  would fail OPEN on every widened constant. Moving the registration into the
  core declaration is not possible either: it carries React (`description:
  ReactNode`) and web-only behaviour, and collections are core.
- **Runtime assert.** A DataView only knows the collections it renders; it would
  catch a missing registration only when someone opens the list.

So: rung 3, a check, but reading code through `sourceAnalysis(ctx)`, fail-closed.

## Design

All three questions answered from the syntax tree + repo module resolution:

1. **Declarations** — `analysis.usesOf({ collection: liveCollection, arm: liveArm }
   @ network/live/core)`: every call, through aliases / barrels / namespaces.
   Unreadable uses are violations. Test files are out of scope.
2. **Tint** — `tintOf(file, expr)` walks a declaration's argument as DATA:
   object / array literals, spreads, `as` / `satisfies` / parens, call
   ARGUMENTS (not callees), and identifiers / `ns.x` followed to their `const`
   initializer (`bindingOf` → `initializerOf`, `exportedBinding` for a
   namespace member), memoized per declaration. A `variant` property's value
   must read as a string literal (through constants) — anything else is
   Unreadable. Function bodies, callees and type nodes are code, not data:
   not walked. Function / class / enum bindings and npm imports carry no tint;
   a non-`const` binding reached as data is Unreadable; globals are skipped.
3. **Registrations** — `usesOf({ investigate: Investigate @ investigate/web })`,
   member calls `.Register(arg)`: the `owner` property of `arg` (an object
   literal) resolved to its declaration. When it is a PARAMETER of an enclosing
   function (a helper like `investigateRuns(arm, …)`), the helper's own uses are
   collected (`usesOf`) and the argument at that index resolved — recursively.
   Anything else unreadable.

Kept: unions answered by their arms; lookup-only collections (no `default` /
`all` key in the spec) skipped; exemptions via `ctx.exempt`.

Removed: every regex, `importAliases`, `callArgs`, `initializerEnd`, the
name-chunked grep loop, the `parse-utils` dependency.

## Files

- `plugins/primitives/plugins/launch/plugins/investigate/check/index.ts` — rewrite.
- `…/check/index.test.ts` — fixtures over an in-memory `createSourceAnalysis`
  (as `source-analysis/core/analysis.test.ts`), adding the cases the regex
  missed: `variant: DESTRUCTIVE`, a spread, `export * as`, an aliased namespace,
  a non-literal variant (unreadable), registration via a helper.

## Verification

- Before/after: the set of tinted declarations and the check verdict on the
  real repo match the old check except where the old one over-tinted by name.
- `./equin test plugins/primitives/plugins/launch/plugins/investigate`,
  `./equin check investigate:failures-registered`, full `./equin check`, `./equin build`.
