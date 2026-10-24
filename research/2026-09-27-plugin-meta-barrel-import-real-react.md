# barrel-import: load the real React instead of a hand-kept stub

## Context

`plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts` replaces `react`,
`react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom` and `react-dom/client` with
hand-written export objects. A static named import is resolved at link time, so any web
module importing a React export missing from that object crashes `./equin build` at
codegen — with an error naming whichever barrel happened to reach the module. It just
happened with `useInsertionEffect` (70da9a639), fixed by adding one name.

This is the third instance of the same drift class in this file (`web-sdk/core` and
`database/server` stubs were already removed for it — 0be620ef2 and the database note).

## Findings

- **No consumer depends on the stub's fake semantics.** All ~13 `importBarrel` call sites
  (codegen slot-declaration guard, token-group-vars, config-origin, plugin-tree facets,
  active-data / config_v2 / page / facets / migrations checks, `page/editor`'s
  `markdown.test.ts` via `loadBlockHandles`) only read plain data off
  `mod.default.contributions` / `.slots` (`_slot`, `descriptor`, `block`, and
  `Function.name` in the contributions facet). Nothing renders, calls a component, or
  calls a hook. Nothing outside `stubs.ts` reads `_currentValue`, `_payload`, `$$typeof`
  or the `"19.0.0-stub"` version.
- **Why it was stubbed:** introduced in 78c40a7a6 (docgen) just to make barrels evaluate in
  Bun. No recorded reason ties it to cost or DOM access. React is a pure JS package: what
  runs at module eval (`createContext`, `memo`, `forwardRef`, `lazy`, `createElement`)
  works without a DOM. `react-dom-client` probes the DOM through
  `window.document.createElement`. The fake `window` has no `.document`, so it takes the
  no-DOM path.
- **Why deriving the stub is the wrong fix:** `react` has no `types` field (its types are in
  `@types/react`, written as `export =` plus a namespace), so `barrel-stubs-gen.ts` cannot
  read it. A derived list of no-ops would also change `useMemo`/`createContext` behaviour,
  and would still be a second copy of React's surface. Loading the real module removes the
  copy entirely. This is the same move as 0be620ef2.
- **Cost:** React is evaluated once per process (ESM cache), not per barrel. Expected cost
  is tens of ms. To be measured (step 1).

## Plan

1. **Probe first.** In a scratch `e2e`-free script inside the worktree (removed afterwards),
   run via `./equin run`: set up the existing fake globals and import real `react`,
   `react/jsx-runtime`, `react-dom` and `react-dom/client`. Time it and confirm there are
   no eval errors or console noise. Stop and report if either fails.
2. **Delete the React family from `stubs.ts`**: remove `reactExports`, `jsxExports`,
   `reactDomExports` and the five `build.module("react…")` registrations. Real packages
   then resolve through normal node resolution. Remove `identity` if it becomes unused.
   Rewrite the `registerBarrelStubs` doc comment: the `web-sdk/core` note no longer says
   "against the React stub", and it gains one paragraph on why React is loaded for real
   (the drift class; nothing reads fake semantics; loaded once).
3. **Leave the fake DOM globals.** They are still needed by other packages' eval-time
   `window`/`document` reads. Keep `window` without a `.document` so `react-dom` stays on
   its no-DOM path, and add a comment saying so.
4. **Regression test:** `barrel-import/core/stubs.test.ts` (bun). It calls
   `registerBarrelStubs`, then `importBarrel`s a small fixture under
   `barrel-import/fixtures/` that statically imports several React / react-dom exports
   the old stub lacked (`use`, `useOptimistic`, `useActionState`, `useInsertionEffect`,
   `react-dom`'s `preload`). It asserts that the import succeeds. This passes by
   construction now, and fails loudly if anyone reintroduces a React stub. Check that
   `fixtures/` is an allowed leaf folder and that importing from it within the plugin
   passes `boundary-rules`. If it does not, put the fixture under `core/testing/`.
5. **CLAUDE.md** of barrel-import: add a short "What is stubbed and why" section. React is
   real. The npm packages in `AUTO_STUB_PACKAGES` are stubbed for cost or CJS conflicts,
   with their exports derived from `.d.ts`. CSS files become empty modules. Say explicitly
   that there must be no hand-written export lists.

## Audit: other hand-maintained mirrors in barrel-import

- `@xyflow/react/dist/style.css` manual `build.module`. It is probably redundant: the path
  resolves through the package's `exports` map to a real `.css` file, which the
  `onLoad(/\.css$/)` rule already empties. **Remove it**, and verify with a build (the
  graph-canvas barrel imports it). This is not an export list, but it is a hand-kept entry.
- `AUTO_STUB_PACKAGES` / `AUTO_STUB_CSS`: a hand-kept list of *packages*, but their
  *exports* are generated, and `barrel-stubs-in-sync` enforces the generation. This is not
  the drift class. Keep.
- The fake `window` / `document` / observers are a hand-kept *shape* mirror, not an export
  mirror. A missing property fails at eval with a real stack trace in the offending
  module, not at link time with a misattributed barrel. Out of scope. If it ever bites,
  the fix is to load `jsdom` (already a dependency) as the global environment, not to add
  properties.
- There are no other `build.module` stubs.

## Verification

- `./equin test plugins/plugin-meta/plugins/barrel-import plugins/page/plugins/editor`
  (the new test, plus `markdown.test.ts`, which loads ~28 web barrels through this path).
- `./equin build` (codegen imports every barrel; the build that broke in 70da9a639
  must pass), then `./equin check` (facets:render-complete,
  token-group-vars-in-sync, plugins-doc-in-sync, boundary checks).
- Compare the codegen phase's wall time in the build log before and after, as a sanity
  check on cost.
