# web-storage keys scoped by the composition they are written from

Task: task-1793824354-ztfcue (lane B of the demo-persistence track; sidequest task-1793668421-gyp9v4).
Track: wiki block-d04c6c0d-56fd-49f2-88f4-914e059cc83b, design block-c0ff62ec-ef7d-44a2-bc97-84423191b2fd.

## Context

`/demo` renders the Agent Manager inside `<DemoScope>` → `<PluginScope composition="agent-manager-demo">`
on the same origin as the desktop (`singularity`). Its server state is now its own (IndexedDB per
storage name), but everything kept in localStorage / sessionStorage through web-storage's
`defineStore` (`s:<owner>:<id>`) is one key space: the demo's Welcome prompt draft is the desktop's,
its data-view states, column widths and pane routes are the desktop's. A later client-only app
embedded in a page must get the same separation with no work.

## Design

**The scope is a property of where the code renders, set by `PluginScope` itself.**
`web-sdk` gets a tiny context: `PluginScope` provides its composition id; `usePluginScopeId()`
answers it, or `null` outside every scope (the page's own deploy, and every test/standalone mount).
No caller can forget to set it: the one primitive that makes a subtree "another deploy" sets it.

**A store is per-composition by default; page-wide only by declaration.**

```ts
defineStore({ owner, …, schema })                    // → ScopedStore<T>: no read/write on it
defineStore({ owner, …, schema, pageWide: { reason } }) // → Store<T>: today's handle
```

- `ScopedStore<T>` has no `read/write/remove/ids/subscribe/key` — the only way in is
  `store.in(scope)` with a branded `StorageScope`, which only `useStorageScope()` mints (from
  `usePluginScopeId()`), or the hook `useStore(store)` = `store.in(useStorageScope())`. So scoped
  code has no unscoped spelling: a type error, not a convention. `in()` returns one cached `Store<T>`
  per scope (stable identity for hook deps).
- `pageWide` (with a written reason) is for state about the browser tab / page shell itself, never
  rendered inside a scope: tab id, app-instance registry, the app tab strip, retired caches,
  diagnostics flags. Reviewed once at the declaration.

**Key grammar.** The page's own deploy keeps `s:<owner>:<id>` — byte-identical to today, so no
existing desktop draft or view state moves or is lost (no migration to get wrong). A nested scope
writes `s:<owner>@<scope>:<id>` (`@` is outside `OWNER_PATTERN`, so the grammar is unambiguous). One
`parseStoreKey` in core is the only parser (cross-tab listener, `removeEntriesWhere`, the health scan).

**Budget stays per owner.** An owner's cap covers its entries in every scope (the first-touch scan
reads `s:<owner>:` and `s:<owner>@*:`), so the `budget-fits` guarantee is unchanged. But no scope
pays for another's growth (found in review): a scope evicts only its own entries; the page's own
scope evicts the scopes' entries first (even in a `refuse` store), then its own oldest for an
`evict-oldest` cache.

**Reset demo** also clears the scope's browser state: `clearStorageScope(id)` removes every
`s:*@<id>:` entry (the page's own keys have no scope id, so it cannot reach them). DemoScope calls
it in every tab, in the effect that starts the fresh host — after the old subtree unmounted and
wrote its last. Modules holding a copy in memory (view-core's drafts cache, the page editor's cut
claims) drop it on `onStorageScopeCleared`.

## Outcome (2026-11-05)

Implemented as above. Page-wide stores (by declaration, with a reason): tab id, app-instance
registry, app tab strip, last focused app, desktop windows (only the page's desktop persists),
action-bar place, Ask equin card (4), pane-restore (recorded from the page's global route), config
git-defaults preview, paste-images browser id, image-viewer prefs, the prototype canvas hand-off,
retired-key cleaners, diagnostics flags. Everything else (drafts, data-view state and drafts,
active views, column widths/collapse, detail-section folds, map cameras, usage orders, prototype
canvases, browser tabs, sticky-scroll positions, cut claims, Sonata/Chord/Places UI state, …) is
per composition.

Known gap: when several tabs see a Reset, each clears on its own schedule; a tab that clears late
could wipe state another tab's fresh demo wrote in between (seconds, while the new host boots).

## Call sites

Every `defineStore` (38) is classified: per-composition (default) or `pageWide`. Consumers of a
scoped store bind it with `useStore(x)` in the component/hook, and pass the bound `Store<T>` to
imperative helpers (`readDraft`/`writeDraft` keep taking a `Store<T>`). `useDraft` accepts a
`ScopedStore<T>` and binds it itself.

## Verification

- Unit tests (web-storage `store.test.ts`): scoped keys, root keys unchanged, cap shared across
  scopes, cross-tab event on a scoped key, `clearStorageScope`.
- `./equin build`; in the browser: type a Welcome draft on the desktop and in `/demo`, each keeps
  its own (and the existing desktop draft survives the build).
- e2e: apps/demo no-leak, app-switch, prototypes-in-demo, sonata-in-demo, persistence, lumen boot.
