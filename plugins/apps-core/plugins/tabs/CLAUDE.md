# tabs

## Shell history: snapshots, not URLs

The shell has one source of truth per tab (each tab's pane store) and **one
linear browser-history timeline that is a pure projection of them**. A history
entry is a **complete snapshot of what the user was looking at**:
`{ tabId, appId, route | pending }`. Nothing reads the URL to decide identity —
the URL and `history.state` are write-only projections; `popstate` is the one
place they are read back.

`TabsProvider` installs the **shell history adapter** (`shell-history-adapter.ts`)
into the pane primitive's `HistoryAdapter` seam (`setHistoryAdapter`):

- **`commit`** stamps the focused tab's `{ tabId, appId }` onto every entry the
  pane store writes, and announces `shell:navigate`. This is the ONE sanctioned
  low-level `window.history` writer in the tabs layer.
- **`restore`** (real browser back/forward only) reads the snapshot back and
  rebuilds it with zero URL parsing: refocus the tab by `tabId`, re-sync its app
  in place if `appId` differs (a fresh store bound to the snapshot's app —
  **never** minting a tab, so a closed-tab entry applies to the focused tab and
  back/forward can't grow the set), then `handleLocationChange()` restores the
  route. Legacy / `{}` entries (pre-deploy, or the apps-layout redirect) fall
  back to `matchAppForPath(URL)`.

**Push vs replace.** Every user-initiated change to what's on screen **pushes**
(pane open/close, `navigate()`, rail click, open-tab, **focus-tab** — Back
traverses tab focus too). **Replace** only for corrections that must not be
independently reachable: boot's initial composite stamp, the canonicalization
redirect, and close-tab neighbor refocus. Restoration never writes history.

**One app-identity source for chrome.** Chrome outside a surface (rail
highlight, theme scope, `:root` tokens) reads the focused tab's app from the
`focusedApp` module store (`apps-core/web` → `setFocusedApp`/`useFocusedAppId`),
published on every focus/app change and synchronously during a restore — never
by parsing the URL. So the theme can never diverge from what the focused surface
shows. The canonicalization redirect (apps-layout) stays URL-driven
(`matchAppForPath`) — that is a legitimately different question.

Because `tabId`s are sessionStorage-stable, a snapshot stamped before a reload
still matches after it, so back/forward keeps working across reloads.

Pane instances survive a reload too: every restored slot keeps its `uuid`
(`restoreRoute` passes it through), and when the address bar is the URL the
focused tab was saved on, the panes parsed from it take the saved slots' uuids
(same pane, same params, same position — `keepInstanceIds`). So state keyed by
the pane instance (a Miller column's collapse, the prototype canvas) comes back
after a reload, while a new link still opens new instances.

## In-app links: one URL resolution, two destinations

`navigate(url, { newTab })` is the only way to open a pane, in this tab or a
fresh one — `openTab(appId)` can reach an app's *index* only, so it can't
express "open THIS pane in a new tab". Keeping it one function keeps both
destinations on one URL resolution (dead-link + unresolved-pane checks
included). A new tab is always fresh, even when the target app is the focused
one.

`appLinkProps(url)` spreads onto any control to give it browser link gestures
(click = `navigate(url)` here, ⌘/Ctrl- or middle-click = `url` in a new
**browser** tab, the browser's own convention), via `primitives/link-gesture`'s
`linkProps` — the same reader the pane primitive's Expand and `openPane.link`
use. A new *in-app* tab is never a modifier on a click: it is an explicit menu
entry calling `navigate(url, { newTab: true })`.

`navigate` is also installed into the pane primitive's `app-nav-sink` here, so a
pane that declares a home app can be promoted into it. Pane sits below tabs and
cannot import it, hence the sink.

## Keep-alive means a background tab still has listeners

Every open tab stays MOUNTED — unfocused ones are `display: none`, and the
floating placement shows several at once. So a `window`-level `keydown` a pane
registers is live in background tabs too, and one Escape reaches all of them.
`useSurfaceFocused()` is the gate: it compares the caller's `useSurfaceTabId()`
against `focusedTabId`, and answers `true` outside any surface (chrome has no
background-tab ambiguity, and returning `false` there would kill the handlers
the hook exists to keep honest).

## App instances: three different things called a "tab"

Keep these apart — they are three layers, and the persisted state hangs off the
middle one:

| Concept | Identity | Lives in |
|---|---|---|
| **Browser tab** | `getTabId()` (`primitives/scope/tab-id`) | one sessionStorage namespace |
| **App instance** | one running SPA app-state, `getAppInstanceId()` (`primitives/scope/app-instance`) | its tab set, focus, surface mode, window geometry |
| **In-app tab** | `tabId` in this plugin's tab set | one pane store |

One browser tab hosts a *sequence* of app instances over its lifetime. Every
cross-document load either **mints** a new instance or **adopts** an existing
one, and that decision — not the browser tab — is what decides whether the user
sees their previous tabs. Persisted keys are therefore
`app-tabs:<tabId>:<gen>` / `app-windows:<tabId>:<gen>`, never the bare
2-segment form. Design: `research/2026-07-24-global-app-instance-boundary.md`.

**The decision table** (owned by `primitives/scope/app-instance`, restated here
because it is what the tab set means):

| Load | Instance | What the user sees |
|---|---|---|
| Bookmark / address bar / link from another app (`navigate`) | **mint** | one tab seeded from the URL, default surface mode, no window geometry |
| Reload (`reload`) | adopt (entry's, else last-active) | unchanged |
| Back/forward across documents (`back_forward`) | adopt the entry's instance | that whole instance — all its tabs, its focus, its surface mode |
| Nav type unavailable (jsdom, older engines) | treated as `reload` | unchanged — unknown must never destroy |
| In-app navigation | n/a (no document load) | unaffected |

Two signals decide it, and both are needed: the **navigation type** decides
*fresh vs. preserve* (it is a property of the load and cannot be clobbered),
while **`history.state.appInstance`** decides *which* instance to adopt. A
history entry therefore **names its instance** alongside its tab — the composite
is `{ tabId, appId, appInstance, route | pending }`. Where the entry's instance
is not this one, `restore()` distrusts its `tabId` entirely and falls back to
URL reparsing; where the entry's `tabId` disagrees with the persisted
`focusedTabId` on a back/forward boot, **the entry wins** (a history entry is a
complete snapshot).

Consequences worth remembering:

- The two-tabs-after-a-bookmark bug is fixed **by the storage key alone**: on a
  `navigate` boot the key names a fresh generation, so `loadPersistedTabs()`
  returns null and the existing seed-one-tab-from-the-URL path runs. Surface
  mode resets for free through `persisted?.mode ?? ""` — boot seeds the
  unresolved `""` (it runs during render, so it must not sample the placement
  registry) and `TabsProvider` resolves it to the registered default reactively,
  against `usePlacementCapabilities()`, on every render.
- Old generations are **not** swept on a fresh boot: Back into an older instance
  is a cross-document load that re-boots from storage, so the retained
  generation count is a real UX knob (how many bookmark hops back restore in
  full). Past it, a back/forward boots a single-tab instance from the entry's
  own snapshot, reusing its `tabId`.
- Nothing here is a device preference. Surface mode and window geometry are
  **instance state** and reset with the instance. (`persistent-draft` is
  deliberately the other way — it is localStorage, shared by design.)
- An **embedded document** (`?embed=…` in either mode, see `primitives/embed`)
  neither loads nor saves the persisted tab set — it shares the host tab's
  `sessionStorage` and its instance is never registered — so it always boots
  one tab from its URL at the default placement. The shell history adapter also
  re-stamps the flag, in the mode the document was opened with, onto every URL
  it writes there, since the pane store builds URLs from the route alone.

### The pre-instance key migration (temporary)

Sessions opened before generations existed hold 2-segment `app-tabs:<tabId>` /
`app-windows:<tabId>` keys. Both consumers read those **gated and consuming**,
never as a bare `??` — the two halves defend the same silent failure (the
pre-deploy state reappearing in an instance that should have started clean) from
opposite sides. The gate is `mayAdoptLegacyPayload()` from
`primitives/scope/app-instance`, which owns the predicate and its rationale (in
particular why `isFreshAppInstance()` alone is *not* it); the consume
(`removeItem`) is the consumer's half, stopping any later fresh instance in the
same browser tab from finding the blob. Both call sites are marked for removal.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Tab manager for the app switcher: the open-tab set, focus model, cross-app navigate(), the focused-placement module store, and the surface-written placement-capabilities registry.
- Web:
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/pane` ×16
    - `primitives/scope/app-instance` ×7
    - `apps-core` ×6
    - `primitives/embed` ×3
    - `primitives/link-gesture` ×2
    - `primitives/latest-ref.useLatestRef`
    - `primitives/scope/install-sink.defineInstallSink`
    - `primitives/scope/surface-id.useSurfaceTabId`
    - `primitives/shortcuts.setFocusedSurfaceId`
  - Exports (types):
    - `NavigateOptions`
    - `PlacementCapabilities`
    - `Tab`
    - `TabsApi`
  - Exports (values):
    - `appContributionFor`
    - `appLink`
    - `appLinkProps`
    - `appPathFor`
    - `exitToPreviousMode`
    - `getSurfaceMode`
    - `loadScopePrefixFor`
    - `navigate`
    - `peekDefaultPlacement`
    - `placementHasAppThemeScope`
    - `placementIsNewTabFollows`
    - `registerPlacementCapabilities`
    - `setSurfaceMode`
    - `TabsProvider`
    - `useActivateApp`
    - `useDefaultPlacement`
    - `usePlacementCapabilities`
    - `useSurfaceFocused`
    - `useSurfaceMode`
    - `useTabs`
- Cross-plugin:
  - Imported by: 31 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps-core` ×9
    - `debug` ×8
    - `apps` ×6
    - `shell` ×2
    - `active-data/song`
    - `build`
    - `config_v2/config-link`
    - `primitives/metrics`
    - `tasks/worktree-identity`
    - `ui/theme-engine/quick-theme`

<!-- AUTOGENERATED:END -->
