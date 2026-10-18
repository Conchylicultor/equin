# Opening a pane on an empty surface

## Context

Since `PlacementDef.allowsEmpty` (bf956d4539), the desktop can hold no window:
`closeTab` on the last tab empties the tab set, sets `surfaceEmpty`, flips the
closed tab's store `live = false` — and **leaves the pane primitive's live-store
sink pointing at that dead store** (`use-tabs.tsx` closeTab, ~L965). On a boot
that restores an empty desktop, the sink is never re-pointed at all, so it still
holds the pane primitive's `defaultStore` (`live: true`, rendered by nothing —
the exact orphan `pane.ts` warns about at `PaneStoreContext`).

Every out-of-surface open resolves its store through that sink:

- `useOpenPane()` → `useStoreResolver()` → `liveStoreSink.peek()` (global chrome:
  the action bar and its popovers — notifications "View all", health-report rows,
  config gears in popovers).
- imperative `openPane()`, `pane.close/promote/unwrap`, `restoreRoute`,
  `clearRoute`, `peekRoute` (`pane.ts` ~L1470–1510, ~L2430, ~L3140).

So the open lands in a store nothing renders: `setRoute` on a background store
only notifies its own (absent) listeners → silent dead click. (The one case that
works by accident: a pane homed in another app, which `strandedRouteUrl` hands
to `navigateApp` → `navigate()`, which already opens a tab when none is focused.)

Observed on main's empty desktop: Builds → a run row works (its pane is homed in
Debug → `navigate()` opens a window). App-rooted links (`navigate()` / `appLink`
— notifications, health rows, Builds expand) already handle the empty surface.

Intended outcome: on an empty surface, any pane open — hook, imperative or link
— opens a new tab (a new window on the desktop) showing that pane.

## Design: the empty-surface store

The rule "every out-of-surface open targets the live store" is right; the bug is
that the empty surface has no *real* live store. Fix it at that one point instead
of in each caller:

> While the surface holds no tab, the live-store sink holds a fresh
> **empty-surface store** — a background `PaneStore` based at the home app. The
> first time its route becomes non-empty, `TabsProvider` *adopts* it as a new
> focused tab.

Every caller keeps working unchanged: `useOpenPane`/`openPane`/`restoreRoute`
compute against an empty route, `setRoute` on the background store notifies
synchronously, and the adoption mints the tab in the same click. A pane homed in
another app still diverts via `strandedRouteUrl` → `navigate()` → `openTabWith`
(the empty store's base path is the home app's, so the comparison is honest).
No change to the pane primitive.

### Changes — `plugins/apps-core/plugins/tabs/web/internal/use-tabs.tsx`

1. **`openTabWith(appId, target, store?)`** — accept an existing store to adopt
   instead of `makeBackgroundStore` (the single tab-minting path stays single).
2. **`enterEmptySurface()`** — one helper used by every way into the empty state:
   - creates `makeBackgroundStore(home.id, apps)` (`registeredHome`); no home
     registered → keep no store and let an open throw loudly (see 4),
   - `setLiveStore(emptyStore)`, `surfaceEmpty = true`,
   - subscribes `emptyStore.subscribeRoute` → on the first non-empty
     `getRouteState()` (resolved with slots, or unresolved/pending): unsubscribe,
     then `openTabWith(home.id, {kind: "route"|"pending", …}, emptyStore)`.
     `activate()` then sets base path, flips `live`, `setLiveStore`, and pushes
     the URL (push — a user-initiated open is a Back target, like `navigate`).
   - The subscription is held in a ref and torn down when any other path leaves
     the empty state (`openTabWith` via `navigate`, `seedHome`, `mintForRestore`)
     so a later open cannot adopt a stale store; `activate()`'s existing
     `surfaceEmpty = false` is the natural place to call a `leaveEmptySurface()`.
3. Call sites:
   - `closeTab` last-tab branch (replaces the bare `prev[idx].store.live = false`
     path; the closed store is dropped).
   - Boot: the one-shot `wiredRef` wiring — `if (focused) setLiveStore(...)
     else enterEmptySurface()` (kills the `defaultStore` orphan on empty boot).
     Subscribing during render is a side effect → do the subscription half in an
     effect keyed on `tabs.length === 0`, but `setLiveStore` stays in the
     one-shot wiring so the sink never holds `defaultStore`.
4. Which app the adopted tab is: the home app. By construction the route either
   belongs to the home app (every pane names a home app — `Pane.define` requires
   `app`); a route homed elsewhere never reaches the store, it goes to `navigate()`.

### Out of scope: the quick-theme "Open theme editor" link

On main's empty desktop it throws `navigate(): no registered app owns path
"/theme-customizer"` (the link is `useActiveApp()?.basePath ?? ""` + route, and
no app is focused). The full theme editor is being deprecated, so it gets no
special case here.

### Docs

`plugins/apps-core/CLAUDE.md` / `tabs/CLAUDE.md` empty-surface section: the
live store on an empty surface is the empty-surface store; its first open
becomes a tab.

## Verification

- Unit (`tabs/web/__tests__/tabs-history.test.tsx` style, jsdom with a
  surface fixture + allowsEmpty placement):
  - close the last tab, `openPane(pane, …, {mode:"root"})` → one tab, focused,
    route = [pane], URL = home base + pane path, one pushed entry.
  - same via `useOpenPane()` rendered outside the surface, and `restoreRoute`.
  - pane homed in another app → tab on that app (existing navigate path).
  - boot with persisted empty set → open works; `defaultStore` never live-sink.
  - empty → `navigate()` opens a tab → later open goes to that tab, not a stale
    empty store.
- `./singularity test plugins/apps-core`.
- `./singularity build`, then browser_* on the desktop: close every window,
  open a build run from the Builds popover (homed path — must still work) and
  an unhomed pane through the live store (e.g. `restoreRoute`/`openPane` from
  global chrome) → a window opens with the pane; reload an empty desktop,
  repeat. (Back from the new window keeps it open — the same as a window
  `navigate()` opens on an empty surface; the shell adapter never closes tabs.)
