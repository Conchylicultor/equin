# app-instance

An **instance** is one running SPA app-state: its tab set, each tab's route, the
focused tab, the surface mode, floating-window geometry. This primitive answers
one question — *which instance does this document belong to?* — and owns
everything that follows from it: the navigation-type read, the instance-scoped
id, the LRU registry and its eviction sweep.

## Three nested things, easy to confuse

| Concept | Identity | Lifetime |
|---|---|---|
| **browser tab** | `getTabId()` (`primitives/scope/tab-id`) | the whole `sessionStorage` session — survives reloads *and* cross-document navigations |
| **app instance** | `getAppInstanceId()` (here) | one running app-state; a bookmark hop starts a new one, a reload keeps it |
| **in-app tab** | `tabId` in `apps-core/tabs` | a tab *within* one instance |

Before instances existed, persisted state was keyed per **browser tab**, so one
browser tab meant one forever-accumulating pile: clicking a bookmark to a
different app restored the whole previous tab set *and* appended a new tab for
the URL. Keying by instance is the fix, and the fix falls out of the key alone.

One document is outside the table: an **embedded** one (`?embed=1`, see
`primitives/embed`). A same-origin frame shares the host tab's `sessionStorage`
— and so this registry — so it mints a fresh generation and never reads, writes
or re-promotes the registry, or a few remounts of the frame would evict and
sweep the host's own generations.

## The decision table

`getAppInstanceId()` is memoized at module level and resolves on first call:

| `getNavigationType()` | `readAppInstance(history.state)` | Action |
|---|---|---|
| `navigate` / `prerender` | anything | **mint** a fresh generation — restore nothing |
| `reload` / `back_forward` | present | **adopt** it |
| `reload` / `back_forward` | absent | adopt the **last-active** generation; mint only if the registry is empty |
| `null` (unavailable) | — | exactly as `reload` |

`isFreshAppInstance()` reports which side of that table this document landed
on: `true` for every **mint**, `false` for every **adopt**. It is the resolved
*outcome*, deliberately not a re-derivation from the navigation type — row 3
with an empty registry is a preserving load that mints anyway, and to a
consumer deciding whether to restore anything that is just as fresh as a
bookmark hop.

## Why two signals

Neither signal alone is enough, and the reason is **asymmetric risk**.

`PerformanceNavigationTiming.type` decides *fresh vs. preserve*. It is a
property of the load itself and cannot be clobbered. `history.state.appInstance`
decides *which* instance to adopt — but it **can** be clobbered:
`apps-layout.tsx:32`'s `redirectTo` used to call
`window.history.replaceState({}, "", url)`, and because `AppsLayout` is the
*parent* of `TabsProvider`, React flushes that effect after the entry has
already been stamped. Nothing re-stamps it.

Under a gen-only design the next Cmd-R would see no generation, conclude
"fresh", and **silently destroy every tab the user had**. With the nav type
primary, a missing generation degrades to the old behaviour instead. The `null`
row is load-bearing for the same reason: jsdom returns `[]` from
`getEntriesByType`, so unknown must never destroy.

## Ids and storage

app-instance hands out no storage keys. `appInstanceId()` returns
`<tabId>:<generation>`; a plugin persisting instance state declares its own
`primitives/dom/web-storage` session store (owner, cap, schema) and uses that
id as the entry id (`tabs-store`, desktop `windows`). The LRU registry is itself
a session store (owner `scope.app-instance`, id = the tab id, value `string[]`
with the active generation LAST). Pre-primitive keys are adopted by each store's
`legacy` hook on its first use (`app-tabs:<tabId>:<generation>` becomes an entry
of `apps-core.tabs`; the pre-generation 2-segment keys are simply dropped).

## Registry, retention, sweep

`RETAINED_INSTANCES = 8`. Old generations are **not** dropped on a fresh boot —
not merely as hygiene, but because Back into an older instance is a
*cross-document* load that re-boots from storage. `N` is therefore a real UX
knob: how many bookmark hops back can be fully restored.

On overflow the head is dropped and a sweep removes every session-store entry,
of ANY owner (`removeEntriesWhere`), whose id is `<tabId>:<generation>` for a
generation that is not retained. Pinning `<tabId>:` as the id prefix makes it
impossible to touch the tab-id entry or the registry's own (their ids carry no
`:<generation>` part) - a property the test suite asserts.

## Two traps

- **The sweep iterates `storage.length` / `storage.key(i)`** (inside
  web-storage), never `Object.keys(sessionStorage)`: a `Storage`'s entries are not
  own enumerable properties, and the vitest suites install a `MemoryStorage`
  *class instance*.
- **`main.tsx` renders under `<StrictMode>`**, so the first caller runs twice in
  dev. Minting *and* every side effect (registry write, eviction sweep) live
  inside the memoized resolver — never at a call site — so the double-invoke is
  idempotent.

## bfcache

A bfcache Back re-shows a document with no boot at all, so nothing would
re-point the registry at that (still alive) instance. A `pageshow` listener
registered on first resolve re-promotes the generation to the tail when
`event.persisted`, so the last-active pointer can't go stale behind a restored
document. The per-generation ids also fix a latent bug: two documents in one
browser tab used to share one entry and clobber each other.

## Failure policy

Storage access degrades rather than throws - a blocked or full `sessionStorage`
must not brick boot - and the store reports every refused write and corrupt
entry itself. A missing or corrupt registry reads as `[]`, which is **not** an
absorbed failure mistaken for success: it is indistinguishable in effect from
"this browser tab has no instances yet", the exact value a first load produces,
and throwing has no recovery path since the registry *is* the pointer to the
payload entries.

`getNavigationType()` returning `null` and `readAppInstance()` returning
`undefined` are honest absences, not swallowed errors - each is a named row of
the decision table.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Per-app-instance generation id: which running SPA state a document belongs to, and the instance-scoped id that storage entries are keyed by.
- Web:
  - Uses:
    - `primitives/dom/web-storage.defineStore`
    - `primitives/dom/web-storage.removeEntriesWhere`
    - `primitives/embed.isEmbeddedDocument`
    - `primitives/scope/tab-id.getTabId`
  - Exports (types): `NavigationType`
  - Exports (values):
    - `appInstanceId`
    - `getAppInstanceId`
    - `getNavigationType`
    - `readAppInstance`
    - `stampAppInstance`
- Cross-plugin:
  - Imported by:
    - `apps-core/tabs`
    - `apps/desktop/windows`
- Test helpers:
  - Web: `@plugins/primitives/plugins/scope/plugins/app-instance/web/testing`
    - `resetAppInstanceForTests` — Drop the memoized generation (and its `pageshow` listener) between tests.

<!-- AUTOGENERATED:END -->
