# web-storage

The one door to `localStorage` / `sessionStorage`. Both are ONE pool per origin
(Chrome: ~10 MB local, the same per tab for session; it cannot be raised) shared
by every plugin. Before this primitive nobody owned a key, no owner had a cap
and nobody could see usage: on 2026-10-19 the theme cache filled localStorage
and every draft and pane-layout write failed, mostly silently.

## Declaring an owner

```ts
export const paneRoutes = defineStore({
  owner: "conversations.pane-restore", // [a-z0-9.-]; keys are `s:<owner>[@<scope>]:<id>`
  label: "Conversation layouts",       // plural, read by the user (toast, health row)
  area: "local",                       // or "session" (one tab's own, dies with it)
  cap: "256 KB",                       // literal: the budget-fits check reads it
  ttl: 30 * DAY,                       // ms since last write; Infinity = never
  whenFull: "evict-oldest",            // caches; "refuse" for what the user typed
  schema: savedRouteSchema,            // zod; an entry IT wrote that fails it is dropped + reported
  legacy: { match: (k) => k.startsWith("route.restore."), adopt },  // pre-primitive keys
});
```

Once, at module scope, with literal `owner` / `area` / `cap`. The handle
(`useStore(store)` — see "Scoped by composition"):
`read(id)` → `{kind:"value", value, ts} | {kind:"none", why}`, `write(id, v)` →
`{ok:true} | {ok:false, reason}` (never throws on a DOMException), `remove`,
`ids()` (oldest first), `subscribe(id, fn)` (same tab and other tabs), `key(id)`.
A draft the user types goes through `persistent-draft` over such a store.

## Scoped by composition

Web Storage is one pool per origin, but a page can render ANOTHER deploy inside
it: `/demo` embeds the Agent Manager in a `<PluginScope>` served by a browser
host. What such a subtree keeps in the browser must be its own, the way its
server state is. So a store is **per composition scope by default**:

- `defineStore({...})` returns a `ScopedStore<T>`, which has no read or write.
  `useStore(store)` binds it to where the calling component renders;
  `store.in(scope)` binds it to a `StorageScope` a component read with
  `useStorageScope()` (for an imperative helper — take the scope, or the bound
  `Store<T>`, as a parameter). A `StorageScope` is minted only from the
  innermost `PluginScope` (web-sdk's `usePluginScopeId()`, which `PluginScope`
  itself sets), so code inside a scope cannot spell another scope's keys.
- The page's own deploy (outside every scope) keeps `s:<owner>:<id>` — the
  keys every entry had before scopes, so nothing stored moved. A scope writes
  `s:<owner>@<scope>:<id>`. `parseStoreKey` (core) is the one parser.
- `pageWide: { reason }` declares a store about the page itself, not about
  what an app inside it shows (the tab's id, the app tab strip, a page-level
  debug flag, the one Ask equin card): it is a plain `Store<T>`, under the
  page's keys wherever it is used from. `useStore` hands one back unchanged,
  so a primitive over stores (`useDraft`) takes either kind.
- An owner's cap covers its entries in every scope (so the budget holds), but
  no scope pays for another's growth: the page's own scope may fill only ¾ of
  a scoped owner's cap (`NESTED_SHARE` — the rest is the scopes' reserve), so
  a cache filled to its cap by the page (its steady state) can never refuse
  every write inside a scope. A scope evicts its own oldest, then other
  scopes' (a cache only), never the page's; the page's own scope evicts the
  scopes' entries first (even in a `refuse` store — state a Reset throws away
  anyway) before its own oldest. Page cache entries found inside the reserve
  (written before it existed) are evicted on first touch.
- `clearStorageScope(id)` removes every entry of one `PluginScope` — the
  demo's Reset (`DemoScope`), after its subtree unmounted. The page's own
  entries have no scope id, so it cannot reach them. A module that keeps what
  it read in memory drops it on `onStorageScopeCleared` (`isKeyInScope`).

Tests outside React use `storageScopeOf(id)` from `web/testing`.

## The guarantees

- **No owner can fill storage for another.** The caps of an area's owners sum
  under `AREA_BUDGET` (core: 7 MB local, 4 MB session — headroom under the
  browser's quota for keys nobody owns). Asserted when a store is declared and,
  for every owner including those in plugins a page never loads, by the
  `web-storage:budget-fits` check.
- **A write over its cap** drops the owner's own expired, then oldest entries
  (`evict-oldest`, counted in the health row) or is refused (`refuse`).
- **Every refused write is loud**: `onStorageFailure` (a toast once per owner
  per page load — `plugins/health`), `storageFailureReportSink` (a deduped
  crash report — `reports/web-storage`), and the counters the health report's
  **Browser storage** row reads.
- **A tab never destroys what another build wrote.** Each entry's envelope
  `{v, ts, s}` carries the stamp of the schema that wrote it (`s`: a hash of
  zod-introspect's `describeSchema` of the owner's schema — equal across
  builds whose schema is the same, moved by any change to what it accepts).
  An entry that fails the reader's schema is judged by that stamp: written
  under the reader's own schema (or not an envelope at all) it is **corrupt**
  — our bytes failing our schema, a bug — dropped and reported; written under
  ANOTHER schema (a tab on an older or newer build — an enum value added, a
  field renamed) it reads as `{kind:"none", why:"other-schema"}` and is left
  in place for the builds that can read it — and announced (once per entry
  per page load) as an `other-schema` failure. Which build is behind it the
  tab cannot know (it does not know whether it is the outdated one); the
  reports pipeline does: `reports/web-storage` files it under its own source,
  which the engine judges by the tab's bundle — from an outdated tab it is
  version skew (muted), from a current tab an older schema's entry this build
  neither reads nor migrates (loud). An entry from before stamps existed has
  no `s`: its writer is unknown, so it counts as another schema's. (Before stamps, a stale tab read a newer build's entry as corrupt
  and deleted it for every tab — 2026-11-11, `demo-scope.host-generation`.)
- **Accounting is O(1) per write.** An owner's keys are scanned once, on first
  touch — that scan is also the TTL sweep and the legacy migration — then kept
  exact from its own writes and the `storage` event.
- **Nothing else touches Web Storage**: the `web-storage/no-raw-web-storage`
  lint rule bans `localStorage` / `sessionStorage` (bare or via `window.`)
  outside `web/internal/store.ts`. Tests and e2e scripts are out of scope.

`removeEntriesWhere(area, match)` removes entries across owners by id — only
for an id grammar one primitive owns the lifetime of (app-instance generations).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The one door to browser storage (localStorage / sessionStorage): defineStore declares an owner — key prefix s:<owner>:, byte cap, TTL, what to do when full (evict-oldest for caches, refuse for what the user typed), a zod schema — and returns a typed read/write/remove/subscribe handle with one {v, ts} envelope — per composition scope by default (a ScopedStore, bound by useStore / in(useStorageScope()): a PluginScope subtree such as /demo writes s:<owner>@<scope>:, never the page's own s:<owner>: keys; pageWide: { reason } for state about the page itself), and clearStorageScope wipes one scope. The caps of an area's owners sum under the browser's quota (asserted at declaration and statically by the budget-fits check), so no owner can fill storage for another. Every refused write and unreadable entry is announced (onStorageFailure); useStorageUsage and scanArea feed the health row; the no-raw-web-storage lint rule bans touching Web Storage anywhere else.
- Web:
  - Slots: `WebStorageSlots.Root`
  - Slot contributors: `WebStorageSlots.Root` ← `primitives.dom.web-storage.health`
  - Contributes: `Core.Root`
  - Exports (types):
    - `AreaBucket`
    - `AreaScan`
    - `LegacyKeys`
    - `ScopedStore`
    - `StorageFailure`
    - `StorageScope`
    - `Store`
    - `StoreRead`
    - `StoreSpec`
    - `StoreUsage`
    - `StoreWrite`
    - `WhenFull`
    - `WriteFailureReason`
  - Exports (values):
    - `clearStorageScope`
    - `defineStore`
    - `isKeyInScope`
    - `onStorageFailure`
    - `onStorageScopeCleared`
    - `removeEntriesWhere`
    - `scanArea`
    - `storageFailureReportSink`
    - `useStorageScope`
    - `useStorageUsage`
    - `useStore`
    - `WebStorageSlots`
- Cross-plugin:
  - Imported by: 52 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives` ×15
    - `apps` ×13
    - `conversations` ×6
    - `apps-core` ×2
    - `framework` ×2
    - `reports` ×2
    - `ui` ×2
    - `companions/browser-extension`
    - `config_v2`
    - `hints/ask`
    - `layouts/miller`
    - `map`
    - `network/live/live-state`
    - `page/editor`
    - `shell/global-action-bar`
    - `tasks/task-draft-form`
    - `wish`
- Exemptions:
  - Exempts itself from: `web-storage/no-raw-web-storage` — `web/internal/store.ts` (sanctioned)
  - Exempted by: `primitives/dom/web-storage` (0 debt)
- Core:
  - Exports (types):
    - `StorageArea`
    - `StorageSize`
    - `StoreKey`
  - Exports (values):
    - `AREA_BUDGET`
    - `AREA_QUOTA`
    - `entryBytes`
    - `KEY_ROOT`
    - `OWNER_PATTERN`
    - `ownerPrefix`
    - `parseStorageSize`
    - `parseStoreKey`
    - `SCOPE_PATTERN`
    - `SCOPE_SEPARATOR`
- Test helpers:
  - Web: `@plugins/primitives/plugins/dom/plugins/web-storage/web/testing`
    - `installStorage` — Make `window.<area>Storage` this storage for the rest of the test file.
    - `QuotaStorage` — An in-memory Storage with a byte quota, throwing the browser's `QuotaExceededError` past it — the condition the 2026-10-19 incident hit and jsdom never produces.
    - `storageScopeOf` — The storage scope a component would read with `useStorageScope()` — `null` for the page's own, a composition id for a `PluginScope` — for a test that reads or writes a scoped store outside React.
- Sub-plugins:
  - **`health`** — Makes browser storage visible: an error toast once per owner per page load when a write is refused (over the owner's cap, the area full, or storage blocked — the value then lives only in memory)…

<!-- AUTOGENERATED:END -->
