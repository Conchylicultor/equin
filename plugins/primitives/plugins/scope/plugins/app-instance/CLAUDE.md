# app-instance

An **instance** is one running SPA app-state: its tab set, each tab's route, the
focused tab, the surface mode, floating-window geometry. This primitive answers
one question — *which instance does this document belong to?* — and owns
everything that follows from it: the navigation-type read, the storage-key
grammar, the LRU registry and its eviction sweep.

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

## Key grammar

```
app-tabs:<tabId>:<generation>          appInstanceKey("app-tabs")
app-tabs:<tabId>                       legacyInstanceKey("app-tabs")  — migration only
singularity.appInstances:<tabId>       the LRU registry, JSON string[], active LAST
```

## Migrating off the legacy key

The 2-segment key exists only so the first load after this deploy doesn't reset
live sessions. Reading it is **gated and consuming**, never a bare `??`:

```ts
const key = appInstanceKey("app-tabs");
let raw = sessionStorage.getItem(key);
if (raw === null && mayAdoptLegacyPayload()) {
  const legacy = legacyInstanceKey("app-tabs");
  raw = sessionStorage.getItem(legacy);
  sessionStorage.removeItem(legacy); // consume: read exactly once, ever
}
```

**Do not hand-roll the gate.** `mayAdoptLegacyPayload()` is the one sanctioned
home for the predicate precisely because it is easy to get wrong in either
direction and *both* failures are silent — each looks exactly like the original
two-tabs bug. Every consumer that persists instance state calls the same
function; none re-derives it.

### The three cases

| This document | May inherit? | Why |
|---|---|---|
| **adopts** a generation | **yes** | a preserving load continuing an instance; a missing gen-scoped key means the session predates the deploy |
| **mints** from a preserving load (`reload` / `back_forward` / `null`) | **yes — this IS the migration** | a pre-generations session has no `appInstance` on its entry *and* an empty registry, so it necessarily resolves to a mint |
| **mints** from an external navigation (`navigate` / `prerender`) | **never** | a bookmark must restore nothing; inheriting here resurrects the pre-deploy tab set on exactly the load whose purpose is to start clean |

Row 2 is the trap. `!isFreshAppInstance()` looks like the right gate and is
not: the migration's *target* case always mints, so freshness alone makes the
migration unreachable and resets every live session's tabs on its next Cmd-R.
Freshness cannot decide this on its own — **for a mint, the deciding question
is what kind of load minted it**, and `navigate` / `prerender` is that
discriminator:

```ts
if (!isFreshAppInstance()) return true;
const nav = getNavigationType();
return nav !== "navigate" && nav !== "prerender";
```

A preserving mint for a *non*-migration reason (an evicted or corrupt registry)
is harmless: post-deploy sessions write gen-scoped keys and consume the legacy
one, so there is nothing left to inherit.

### And consume it

`removeItem` after the read closes the hole from the other side. Without it the
blob outlives the migrating load, and a later external navigation in the same
browser tab — which row 3 forbids from inheriting — would still find it if the
gate ever regressed. Consuming makes row 3 unreachable by construction rather
than only by policy.

The next `persist()` writes the gen-scoped key, so one preserving load carries
the state across. Mark both call sites for removal once deployed.

## Registry, retention, sweep

`RETAINED_INSTANCES = 8`. Old generations are **not** dropped on a fresh boot —
not merely as hygiene, but because Back into an older instance is a
*cross-document* load that re-boots from storage. `N` is therefore a real UX
knob: how many bookmark hops back can be fully restored.

On overflow the head is dropped and a sweep deletes every sessionStorage key
matching `^[^:]+:<tabId>:(.+)$` whose captured generation is not retained.
Pinning `<tabId>` to position 2 makes it *structurally impossible* to touch
`singularity.tabId` (no colon at all), a 2-segment legacy key, or the registry's
own key — a property the test suite asserts rather than a convention.

## Two traps, both verified

- **Iterate with `storage.length` / `storage.key(i)`, never
  `Object.keys(sessionStorage)`.** A `Storage`'s entries are not own enumerable
  properties, and the vitest suites install a `MemoryStorage` *class instance*
  whose only own enumerable property is its private `store` field.
- **`main.tsx` renders under `<StrictMode>`**, so the first caller runs twice in
  dev. Minting *and* every side effect (registry write, eviction sweep) live
  inside the memoized resolver — never at a call site — so the double-invoke is
  idempotent.

## bfcache

A bfcache Back re-shows a document with no boot at all, so nothing would
re-point the registry at that (still alive) instance. A `pageshow` listener
registered on first resolve re-promotes the generation to the tail when
`event.persisted`, so the last-active pointer can't go stale behind a restored
document. The per-generation keys also fix a latent bug: two documents in one
browser tab used to share `app-tabs:<tabId>` and clobber each other.

## Failure policy

Storage access degrades rather than throws, following `tab-id`'s precedent — a
blocked or full `sessionStorage` must not brick boot. A corrupt registry
degrades to `[]`, which is **not** an absorbed failure mistaken for success: it
is indistinguishable in effect from "this browser tab has no instances yet", the
exact value a first load produces, and throwing has no recovery path since the
registry *is* the pointer to the payload keys.

`getNavigationType()` returning `null` and `readAppInstance()` returning
`undefined` are honest absences, not swallowed errors — each is a named row of
the decision table.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Per-app-instance generation id: which running SPA state a document belongs to, and the storage-key grammar scoped to it.
- Web:
  - Uses:
    - `primitives/embed.isEmbeddedDocument`
    - `primitives/scope/tab-id.getTabId`
  - Exports (types): `NavigationType`
  - Exports (values):
    - `appInstanceKey`
    - `getAppInstanceId`
    - `getNavigationType`
    - `legacyInstanceKey`
    - `mayAdoptLegacyPayload`
    - `readAppInstance`
    - `stampAppInstance`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `apps-core/tabs`
    - `apps/desktop/windows`
- Test helpers:
  - Web: `@plugins/primitives/plugins/scope/plugins/app-instance/web/testing`
    - `resetAppInstanceForTests` — Drop the memoized generation (and its `pageshow` listener) between tests.

<!-- AUTOGENERATED:END -->
