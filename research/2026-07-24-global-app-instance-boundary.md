# App instances — a fresh SPA state when you arrive from outside, preserved state when you don't

## Context

Open `http://singularity.localhost:9000/agents/…` in a browser tab, then click a bookmark to
`http://singularity.localhost:9000/sonata`. You end up with **two** in-app tabs: the restored
agent-manager tab plus a new Sonata tab.

A bookmark click is a cross-document navigation, so the SPA cold-boots. `sessionStorage` survives
a same-tab navigation (and `getTabId()` itself lives there, so the namespace key is unchanged), so
`bootTabs` finds the previous session's tab set and restores all of it as background tabs —
`use-tabs.tsx:259-262`, *"keep-alive must survive a reload, so no other app's tab is dropped"*.
It then looks for a tab belonging to the URL's app, finds none, and pushes a new one
(`use-tabs.tsx:271-278`) so the URL's app is never silently dropped.

Two rules collide: **restore everything on reload** (keep-alive) and **the URL is authoritative for
focus**. Together they make any external navigation to a not-currently-open app *additive*. The same
intent expressed in-app is not: the rail calls `replaceTabApp(focusedTabId, appId)`
(`app-rail.tsx:38`) and reuses the focused tab.

The missing concept is an **instance**. Today the persisted tab set is keyed per *browser tab*, so
one browser tab means one forever-accumulating pile of state. It should be keyed per *instance*:
one running SPA app-state — its tab set, routes, focus, surface mode, floating-window geometry.

### Target behaviour (user-confirmed)

| Load | Instance |
|---|---|
| Bookmark / address bar / link from another app (`navigate`) | **fresh** — one tab seeded from the URL, default surface mode, no window geometry |
| Reload (`reload`) | same instance, unchanged |
| Back / forward across documents (`back_forward`) | **the instance that entry belonged to, in full** — all its tabs, its focus, its surface mode |
| In-app navigation | unaffected (no document load) |

Confirmed decisions: Back restores the **whole** previous instance, not just that one page; surface
mode and window geometry are **instance state and reset** on a fresh instance, not device
preferences. Where an entry's own `tabId` disagrees with the instance's persisted `focusedTabId`,
**the entry wins** — consistent with "a history entry is a complete snapshot"
(`plugins/apps-core/plugins/tabs/CLAUDE.md`).

## Design

Governing architecture to read first: `research/2026-07-18-global-shell-history-snapshots.md` and
`plugins/apps-core/plugins/tabs/CLAUDE.md`. A history entry is already a complete snapshot,
`{ tabId, appId, route | pending }`. This change adds one field — which **instance** wrote it — and
keys persisted state by it.

### Two signals, not one

- **`PerformanceNavigationTiming.type`** decides *fresh vs. preserve*. It is a property of the load
  itself and cannot be clobbered.
- **`history.state.appInstance`** decides *which* instance to adopt.

Both are needed, and the reason is asymmetric risk. `apps-layout`'s `redirectTo` does
`window.history.replaceState({}, "", url)` (`apps-layout.tsx:32`), destroying the snapshot. This
is not theoretical: on a bare-root boot the gate returns `true` unconditionally
(`redirect-gate.ts:33`), and because `AppsLayout` is the **parent** of `TabsProvider`
(`apps-layout.tsx:154`), React flushes its effect *after* `TabsProvider`'s wiring effect has already
replace-stamped the entry (`use-tabs.tsx:797-805`). Nothing re-stamps it. Under a gen-only design,
the next Cmd-R would see no gen, conclude "fresh", and **silently destroy every tab the user had**.
With the nav type primary, a missing gen degrades to today's behaviour instead.

| `navigation.type` | `history.state.appInstance` | Action |
|---|---|---|
| `navigate` / `prerender` | anything | **mint** a new instance, restore nothing |
| `reload` / `back_forward` | present | adopt that instance |
| `reload` / `back_forward` | absent (legacy entry, redirect clobber) | adopt the **last-active** instance; mint only if none |
| unavailable (jsdom, older engines) | — | treat as `reload` — unknown must never destroy |

The last row is load-bearing: jsdom returns `[]`, so every existing `boot-tabs.test.ts` case keeps
restoring unchanged.

### New primitive: `primitives/app-instance`

Sibling of `tab-id`, depending on it. It owns the whole question — the nav-type read, the key
grammar, the registry and eviction — so consumers change by one line each and take **no new coupling
to one another**.

```ts
getAppInstanceId(): string                  // memoized; mints or adopts on first call
appInstanceKey(prefix: string): string      // `${prefix}:${getTabId()}:${gen}`
legacyInstanceKey(prefix: string): string   // `${prefix}:${getTabId()}` — migration only
stampAppInstance<T extends object>(s: T): T & { appInstance: string }
readAppInstance(state: unknown): string | undefined
getNavigationType(): NavigationType | null  // the ONE getEntriesByType("navigation") type read
resetAppInstanceForTests(): void
```

Not folded into `tab-id`: that primitive is pure sessionStorage and is imported by seven plugins
(`reports`, `live-state`, `notifications`, …) that only want crash attribution. Teaching it to read
`history.state` widens its concept. Not extended onto boot-trace's `readNavTiming()`
(`perfs/boot-trace/web/internal/store.ts:90-92`) either: that is reachable only through
`getBootTrace()`, which also does a full Resource-Timing scan, and pointing a correctness-critical
boot path at a diagnostics barrel inverts the dependency direction.

**Registry + eviction**, one extra key `singularity.appInstances:<tabId> → string[]` (LRU, active
last). Retain `N = 8`; on overflow drop from the head and sweep any sessionStorage key matching
`^[^:]+:<tabId>:(.+)$` whose gen is not retained. Requiring `<tabId>` in position 2 makes it
impossible to touch `singularity.tabId` or a 2-segment legacy key.

> Old generations are **not** deleted on a fresh boot — not merely as hygiene, but because Back into
> an older instance is a *cross-document* load that re-boots from storage. `N` is therefore a real UX
> knob: how many bookmark hops back you can fully restore.

Two implementation traps, both verified:

- Iterate with `storage.length` / `storage.key(i)`, **never** `Object.keys(sessionStorage)`. The
  vitest suites install a `MemoryStorage` class instance (`boot-tabs.test.ts:26-46`) whose only own
  enumerable property is its private `store` field.
- `main.tsx` renders under `StrictMode`, so `bootTabs` runs twice in dev. Keep every side effect
  (registry write, sweep) inside the memoized resolver.

**Legacy migration.** Existing sessions hold `app-tabs:<tabId>` with no gen; the first post-deploy
load would find nothing and reset everyone's tabs once. Each consumer reads
`getItem(appInstanceKey(p)) ?? getItem(legacyInstanceKey(p))`; the next `persist()` writes the
gen-scoped key and the 2-segment legacy key dies with the session. Mark both sites for removal.

### Why `bootTabs` needs almost no change

The headline bug is fixed by the storage key alone: on a `navigate` boot the key names a
brand-new generation, `loadPersistedTabs()` returns `null`, and the existing code seeds exactly one
tab from the URL. Surface mode resets for free via the existing
`persisted?.mode ?? getDefaultPlacement()` (`use-tabs.tsx:314`). That the fix falls out of the key is
the strongest evidence the model is right.

Two small optional additions, worth taking:

- On a `back_forward` boot, prefer the `tabId` the entry names when it exists in the restored set
  (`use-tabs.tsx:267-278`). Plain single-step Back already agrees; this covers jumping directly to an
  older entry via the history dropdown.
- Accept a seed `tabId` so the evicted-generation path can reuse the entry's id rather than minting
  one the adapter's `restore()` won't recognise.

### `redirectTo` fix (in scope, one line)

`apps-layout.tsx:32` → `window.history.replaceState(window.history.state ?? {}, "", url)`.

Safe: the redirect only fires when the URL matches no app, in which case `bootTabs` resolved
`urlAppId` through the `seedAppId` → `defaultApp(apps)` fallback (`use-tabs.tsx:247-248`) — the same
app `defaultPath` targets — so the preserved `appId` already agrees with the post-redirect URL and
the preserved route is `[]`/pending. This removes the only in-repo producer of state-less entries.
**Keep** the adapter's legacy branch (`shell-history-adapter.ts:114-129`) and its lint exemption:
pre-deploy entries in live sessions still lack `tabId`/`appId`.

## Edge cases

- **bfcache Back** — no boot at all; the instance is literally alive, a superset of what the boot
  path reconstructs. The generations additionally fix a *latent bug today*: two documents in one
  browser tab currently share `app-tabs:<tabId>` and clobber each other; per-gen keys can't collide.
  Harden with a `pageshow` listener that re-writes `last = gen` when `event.persisted`, so the
  last-active pointer can't go stale behind a restored document.
- **Foreign-instance popstate** — same-document popstate can only reach entries its own instance
  wrote, so generations make the adapter's closed-tab branch *narrower*. Add a guard at the top of
  `restore()`: if `raw.appInstance` is present and ≠ `getAppInstanceId()`, take the URL-reparse
  branch rather than trusting a foreign `tabId`. Fall back, don't throw — this is a user-facing
  popstate handler.
- **`back_forward` into an evicted generation** — boot a single-tab instance from the entry's own
  snapshot, reusing its `tabId`. Defined degradation.
- **Duplicate tab** — Chrome copies sessionStorage *and* history, so both documents adopt the same
  gen and share its payload. Identical to today; explicitly out of scope per the shell-history doc.
- **Browser restart / session restore** — engines report `back_forward` and restore sessionStorage,
  so the instance returns. This is the design's biggest unverified assumption; a browser reporting
  `navigate` yields a fresh single tab — degradation, never corruption.
- **Same URL re-entered in the address bar** — some engines report this as `reload`, landing in row 3
  and restoring rather than starting fresh. Mild under-delivery in a rare case, in the safe direction.
- **`history.state` size** — one 36-byte uuid against a ~2 MB Chrome cap. Non-issue.
- **Out of scope, flagged:** `persistent-draft` (`use-draft.ts:38`) is **localStorage** and shared
  across tabs *by design*, so drafts survive a fresh instance. Correct as-is; noting it so the
  asymmetry is deliberate. Separately, a `back_forward` boot still rebuilds the focused route by
  re-parsing the URL rather than reading `history.state.route`, losing opener-supplied `PaneOptions`
  — that already happens on every reload and deserves its own change.

## File-by-file

| File | Change | Effort |
|---|---|---|
| `plugins/primitives/plugins/app-instance/web/internal/app-instance.ts` *(new)* | nav-type read, memoized resolver, LRU registry, sweep, key builders, stamp/read, `pageshow` hardening, test reset | M |
| `plugins/primitives/plugins/app-instance/web/index.ts` *(new)* | barrel + `PluginDefinition` with `contributions: []` — mirror `tab-id/web/index.ts` | S |
| `plugins/primitives/plugins/app-instance/{package.json,CLAUDE.md}` *(new)* | mirror `tab-id`; CLAUDE.md carries the instance model + decision table | S |
| `plugins/apps-core/plugins/tabs/web/internal/tabs-store.ts` | `storageKey()` → `appInstanceKey("app-tabs")` (`:80-82`); legacy fallback in `loadPersistedTabs` (`:139-152`) | S |
| `plugins/apps-core/plugins/surface/plugins/floating/web/hooks/use-floating-windows.ts` | `LS_KEY` → `appInstanceKey("app-windows")` (`:229`); legacy fallback in `hydrate` (`:305`) | S |
| `plugins/apps-core/plugins/tabs/web/internal/shell-history-adapter.ts` | `commit` stamps `appInstance` (`:94-104`); foreign-instance guard in `restore`; widen `CompositeState` (`:35`) | S |
| `plugins/apps-core/plugins/layout/web/components/apps-layout.tsx` | `redirectTo` preserves `history.state` (`:32`) | S |
| `plugins/apps-core/plugins/tabs/web/internal/use-tabs.tsx` | prefer the entry's `tabId` for focus on `back_forward`; accept a seed `tabId` (`:259-278`) | S–M |
| `plugins/apps-core/plugins/tabs/CLAUDE.md`, `plugins/primitives/plugins/pane/CLAUDE.md` | document instances vs. tabs; an entry names its instance | S |
| registry + autogen doc blocks | via `./equin build` — `plugins-registry-in-sync` fails otherwise | S |
| `plugins/apps-core/lint/index.ts` | **no change** — the primitive writes no history; `apps-layout.tsx` already exempt (`:21-23`) | — |

One new leaf primitive plus roughly a dozen changed lines across four existing files.

## Verification

**Unit — `plugins/primitives/plugins/app-instance/web/__tests__/app-instance.test.ts` (new).**
Stub `performance.getEntriesByType` (`vi.spyOn`, the idiom already used for `window.history` in
`tabs-history.test.tsx`), reuse the `MemoryStorage` class from `boot-tabs.test.ts:26-46`, call
`resetAppInstanceForTests()` in `beforeEach`. Cover: each row of the decision table; **`reload` +
`{}` state ⇒ adopts last-active, not fresh** (the regression test for the gen-only failure);
memoization under double-invoke; eviction keeps `N` and spares `singularity.tabId` + legacy keys.

**Unit — existing tabs suites.** `boot-tabs.test.ts`'s `persist()` helper (`:58-61`) writes under
`appInstanceKey("app-tabs")`; with nav type unavailable ⇒ `reload`, **all seven existing cases must
pass unchanged** — the no-regression gate. Add: `navigate` + a populated payload ⇒ exactly one tab
seeded from the URL at the default mode (the reported bug, at unit level); `back_forward` with an
entry naming a non-focused restored tab ⇒ that tab is focused.
`shell-history-adapter.test.ts`: `commit` writes `appInstance`; `restore` with a foreign
`appInstance` takes the URL-reparse branch and never calls `refocus` with the foreign `tabId`.

```bash
bun run test:dom plugins/apps-core/plugins/tabs plugins/primitives/plugins/app-instance
```

**E2E — `plugins/apps-core/plugins/tabs/e2e/history-nav.ts`.** Its `persistedTabs()` helper
(`:63-74`) must be fixed regardless: `Object.keys(sessionStorage).find(k => k.startsWith("app-tabs:"))`
now matches an arbitrary generation — key it off `history.state.appInstance` with a last-active
fallback. Then add scenario **E**, the acceptance test, mapping 1:1 onto the four requirements:

1. `goto /agents/…`, open a second in-app tab ⇒ 2 persisted tabs.
2. `goto /sonata` (a real cross-document navigation — what a bookmark does) ⇒ **1** persisted tab,
   `appId === "sonata"`. *This is the reported bug.*
3. surface mode is the default and no `app-windows:*:<newGen>` key exists.
4. `page.reload()` ⇒ still 1 tab, same gen.
5. `page.goBack()` ⇒ on `/agents/…` with **2** tabs and the pre-bookmark `focusedTabId`.
6. `page.goForward()` ⇒ `/sonata`, 1 tab.
7. `history.state.appInstance` differs between the `/agents` and `/sonata` entries — pins the
   mechanism, not just the symptom.

All assertions via `r.ok(...)` / `r.finish()` so it stays a real gate.

```bash
./equin build
bun plugins/apps-core/plugins/tabs/e2e/history-nav.ts
```

**Manual.** In one browser tab: open two in-app tabs under `/agents`, switch the surface to floating
windows and move a window, then click a bookmark to `/sonata` ⇒ one tab, docked, no windows. Cmd-R ⇒
unchanged. Back ⇒ both `/agents` tabs, floating mode, window geometry restored. Forward ⇒ Sonata.
