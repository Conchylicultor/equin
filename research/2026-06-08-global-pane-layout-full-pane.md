# Full-pane layout + Sonata persistent song URLs

> Generalize the pane-layout system so apps can render their route through a
> **Miller** (columns) renderer or a new **Full-pane** (single full-surface)
> renderer — and migrate Sonata's player to a persistent `/sonata/song/:id`
> pane.

## Context

Today the pane system has exactly one renderer: **Miller columns**
(`plugins/layouts/plugins/miller`). The shell hardwires `<MillerColumns/>` and
every app that wants routing gets columns. Apps that want a full-surface UI
(Sonata's player, future maps, etc.) have no layout to mount, so **Sonata opted
out of the pane system entirely**: its library/player navigation is bespoke
React state (`view: "library" | "player"`, `currentSongId`), with **no URL
persistence** — opening a song never changes the URL, and a reload always drops
you back on the library. It only mounts `PaneOverlayHost` so the *global*
theme-customizer pane can float over its custom UI.

We want two things:

1. A **Full-pane layout** as a peer to Miller, so an app can render its route as
   a single full-surface pane. An app may use **both** (columns for some panes,
   full-surface for others) — so layout choice must be expressible per app/route,
   **owned by the layout layer, never declared on the pane itself**.
2. **Sonata's player becomes a pane** at `/sonata/song/:songId` — a real URL
   that survives reload and back/forward — rendered full-surface.

## The model: one router substrate, N layout renderers

The key realization: **the reusable machinery already lives in the pane
primitive** (`plugins/primitives/plugins/pane/web/pane.ts`), not in Miller. The
primitive owns the *route* — `currentChain: PaneSlot[]`, an ordered list of
active panes derived from the URL and persisted in `history.state` — plus the
registry, URL parse/build, and resolve/loading gating. Miller is just a thin
consumer that paints that route as columns.

So "generalizing Miller" = **demote columns/leaf to Miller's private vocabulary,
and add a second thin renderer.** Layered:

```
4. App            mounts a layout renderer (or a host that switches by active pane)
3. Layout         FullPane | MillerColumns | (future: Tabs, Grid…)  ← owns arrangement
2. Route          URL ⇄ ordered active panes, persisted in history   ← pane primitive
1. Pane registry  Pane.define({ id, segment, component, resolve })   ← pane primitive
```

Two navigation styles fall out of the **same** substrate, by the verb used:

- **Miller (master-detail):** navigate with `mode:"push"` → the route *grows*
  `[list, detail, …]`; Miller paints every entry as a column (ancestors stay
  visible). A multi-pane route is intrinsic to columns.
- **Full-pane (screen stack):** navigate with `mode:"root"` → each screen
  *replaces* the route with a single pane and pushes a browser-history entry.
  The route is **always depth-1**; back/forward is browser history. There is no
  chain, no leaf, no ancestors — just "the current screen." A single full pane
  is genuinely a single pane.

In the shared layer the only neutral concept is **the active pane =
`match.chain.at(-1)`** ("where you are"). Miller additionally renders everything
*before* it as columns; Full-pane renders *only* it. "Leaf of a chain" was just
Miller's name for the active pane.

**Naming decision (locked):** reuse the existing substrate as-is — no mass
rename of `currentChain`/`useMatchForChain`. New full-pane code and docs talk
"route / active pane"; `chain`/`columns`/`leaf` stay Miller-internal.

## Public API (what a new app author writes)

Each layout is a mountable renderer under `plugins/layouts/plugins/*`. An app's
`Apps.App.component` mounts one. **The pane never declares its layout.**

```tsx
// Pure column app (Pages, agent-manager, …) — unchanged:
component: () => <AppShellLayout sidebarSlot={Pages.Sidebar} toolbarSlot={Pages.Toolbar} />

// Pure full-surface app (Sonata, a future map app) — mount the new renderer:
component: FullPane            // renders the active pane (route.at(-1)) full-surface

// Mixed app — mount the host, naming THIS app's own panes that are full:
import { PaneLayoutHost } from "@plugins/layouts/plugins/host/web";
import { settingsPane } from "./panes";

function MyAppSurface() {
  // active pane in `full` → FullPane; otherwise → MillerColumns columns.
  return <PaneLayoutHost full={[settingsPane]} />;
}
```

`PaneLayoutHost` references the **app's own** pane objects (not a cross-plugin
contributor) — so layout ownership lives in the layout layer, panes stay pure,
and no boundary rule is violated. Sonata is pure full-surface, so it mounts
`<FullPane/>` directly; the host exists for apps that genuinely mix.

## Shared scaffolding (the "reuse")

Both renderers + `PaneOverlayHost` repeat the same preamble. Formalize it as one
exported hook in the pane primitive (`pane.ts`), so renderers are thin and never
copy-paste:

```ts
// pane.ts — runs the shared preamble, returns the route match (chain or index).
export function usePaneRoute(basePath: string): PaneMatch | null {
  useMemo(() => setBasePath(basePath), [basePath]);   // sync side-effect
  useSyncPaneRegistry();
  const chain = useMatchForChain();
  const index = useIndexMatch(basePath);
  return chain ?? index;
}
```

Renderers accept an **optional `match` prop** so they work both standalone
(self-resolve + provide `PaneMatchContext`) and under the host (consume the
host's already-resolved match + context — no double sync):

```tsx
function FullPane({ match: provided }: { match?: PaneMatch }) {
  const basePath = useContext(PaneBasePathContext);
  const selfMatch = usePaneRoute(basePath);
  const match = provided ?? selfMatch;
  const active = match?.chain.at(-1);
  if (!active) return null;                            // empty route, no index pane
  const body = (
    <PaneInstanceContext.Provider value={active.instanceId}>
      <PaneLayoutContext.Provider value={null}>      {/* no maximize/drag in full-pane */}
        <div className="h-full min-h-0">
          <PaneResolveGuard pane={active.pane} params={active.params} />
        </div>
      </PaneLayoutContext.Provider>
    </PaneInstanceContext.Provider>
  );
  return provided ? body : <PaneMatchContext.Provider value={match}>{body}</PaneMatchContext.Provider>;
}
```

`PaneResolveGuard` already honors `chrome:false` (renders the component
directly) and gates on `resolve().found` (loading/not-found) — so async
hydration needs no new machinery.

## Implementation stages + files

### Stage 1 — Pane primitive (additive, zero risk)
`plugins/primitives/plugins/pane/web/pane.ts` + barrel `web/index.ts`:
- Add `usePaneRoute(basePath)` (above). Export it.
- Add `clearChain()` — `restoreChain` refuses an empty array and `setChain([])`
  is internal, so there is **no public "go to empty route."** Full-pane apps
  need it for "back to index" (e.g. ← Library). Tiny wrapper:
  ```ts
  export function clearChain(): void {
    if (typeof window === "undefined") return;
    setChain([]);   // → URL "/<app>", empty chain → index pane via useIndexMatch
  }
  ```
- No `layout` field on `Pane.define` (explicitly rejected — layout is the
  renderer's concern). No changes to existing pane consumers.

### Stage 2 — Full-pane renderer
New `plugins/layouts/plugins/full-pane/web/` (peer to `miller`):
- `components/full-pane.tsx` — `<FullPane match?>` (above).
- `index.ts` (barrel, `export default definePlugin(...)`, re-export `FullPane`),
  `package.json`, `CLAUDE.md` (prose only; build codegen inserts the reference
  block — see memory `reference_claudemd_autogen_block`).

### Stage 3 — Mixing host
New `plugins/layouts/plugins/host/web/` (depends on both miller + full-pane):
- `components/pane-layout-host.tsx` — `<PaneLayoutHost full={PaneObject[]}>`:
  `const match = usePaneRoute(basePath); const active = match?.chain.at(-1);`
  then render `<PaneMatchContext.Provider value={match}>` wrapping
  `active && full.some(p => p._internal === active.pane) ? <FullPane match/> : <MillerColumns match/>`.
- Barrel + `package.json` + `CLAUDE.md`.

### Stage 4 — Miller accepts optional `match`
`plugins/layouts/plugins/miller/web/components/miller-columns.tsx`:
- Add optional `match?: PaneMatch` prop. When provided, skip `usePaneRoute`
  self-resolve and the `PaneMatchContext` provider (host already provided both);
  otherwise behave exactly as today. **Backward compatible** — every existing
  `<MillerColumns/>` mount (app-shell-layout, deploy) is untouched.
- Leave `PaneOverlayHost` in place (other apps may still import it).

### Stage 5 — Sonata panes
New `plugins/apps/plugins/sonata/plugins/shell/web/panes.tsx`:
```ts
export const sonataLibraryPane = Pane.define({
  id: "sonata-library", segment: "", appPath: "/sonata", chrome: false,
  component: SonataLibrarySurface,       // renders <Sonata.Home.Render>
});
export const sonataPlayerPane = Pane.define({
  id: "sonata-player", segment: "song/:songId", chrome: false,
  input: type<{ title: string }>(),
  resolve: useSonataPlayerResolve,       // async source hydration (Stage 6)
  component: SonataPlayerSurface,        // the player chrome (was the view==="player" branch)
});
```
Register both via `Pane.Register({ pane })` in the shell `index.ts`.
- `SonataLibrarySurface` = the `view==="library"` branch of `SonataLayoutInner`
  (just `<Sonata.Home.Render>`), as a pane component.
- `SonataPlayerSurface` = the `view==="player"` branch (toolbar with ← Library +
  title + Display `Picker` + `Sonata.Toolbar`, `Sonata.Transport`,
  `Sonata.Display.Dispatch` main area, and `SectionPane`). Move `Picker` and
  `SectionPane` with it. Reads `songId` from `sonataPlayerPane.useParams()` and
  optimistic title from `useInput()`.

### Stage 6 — Sonata player resolve (async hydration)
`useSonataPlayerResolve({ songId })` in `panes.tsx` — lift the body of
`useOpenSong` (`library/web/hooks.ts`) into a resolve hook so it runs on **direct
navigation / reload**, not just a library click:
- `const song = useResource(songsResource).find(s => s.id === songId)` (existence + title).
- effect keyed on `songId`: `await Promise.all(Library.Source … hydrate(songId))`
  → `setRawMap(rawMap)` → `setHydrated(true)`; cancel-guard on unmount.
- return `{ pending: !hydrated, found: hydrated && !!song }`.

### Stage 7 — Sonata context: delete `view`, re-home once-per-open state
`plugins/apps/plugins/sonata/plugins/shell/web/context.tsx`:
- Remove `view`, `setView`, `viewRef`, and `backToLibrary` (the bespoke switch).
- Keep `currentSongId` / `currentSongTitle` / `songOpenEpoch` (downstream
  effects like `playback-history` read them). Replace `openPlayer` with
  `setCurrentSong({ id, title })` that sets id/title and **bumps
  `songOpenEpoch`** — called by `SonataPlayerSurface` **on mount** (each player
  open is a fresh `mode:"root"` instance → remount → one bump per open,
  preserving the "re-arm once-per-open" semantics). Clear `currentSongId` on
  unmount so library-state effects don't mis-attribute.
- **Transport keyboard gate:** today `togglePlay` checks `viewRef==="player"`.
  Move `publishSonataTransport({...})` / `publishSonataTransport(null)` into
  `SonataPlayerSurface`'s mount/unmount effect, so transport is live exactly
  while the player is on screen — no `view` gate needed.

### Stage 8 — Sonata navigation → pane nav
- `library/web/hooks.ts` `useOpenSong`: replace `setRawMap(...) + openPlayer(...)`
  with `openPane(sonataPlayerPane, { songId: song.id }, { mode: "root", input: { title: song.title } })`.
  Hydration now lives in `resolve` (Stage 6); drop it here (or keep as optimistic
  pre-load — minimal version just opens the pane).
- ← Library button → `clearChain()` (Stage 1). Works for deep-links too
  (`/sonata/song/123` → `/sonata` → library index), unlike `history.back()`.

### Stage 9 — Sonata layout: mount FullPane, drop bespoke + overlay
`plugins/apps/plugins/sonata/plugins/shell/web/components/sonata-layout.tsx`:
```tsx
export function SonataLayout() {
  return (
    <SonataProvider>
      <div className="h-full min-h-0">
        <FullPane />                       {/* renders the active Sonata pane full-surface */}
        <Sonata.Effect.Render>{(e) => <e.component key={e.id} />}</Sonata.Effect.Render>
      </div>
    </SonataProvider>
  );
}
```
- Delete `SonataLayoutInner`, the `view` switch, and `PaneOverlayHost` import.
  `FullPane` renders: empty route → library index; `[player]` → player; and a
  global pane (theme customizer, opened via a global action that resets the
  route) → that pane full-surface. The last is **consistent** with Miller apps,
  where the customizer is the sole full-width column. (Trade-off: opening
  settings mid-playback unmounts the player; acceptable for a rare action, and
  the song restores via `resolve` on return.)

### Stage 10 — Docs
- `plugins/layouts/CLAUDE.md`: list `full-pane` + `host`; note Miller's
  columns/leaf vocabulary is layout-private; the substrate is the "route."
- `plugins/primitives/plugins/pane/CLAUDE.md`: document `usePaneRoute`,
  `clearChain`, and that layout is chosen by the renderer, not the pane.
- New plugins' `CLAUDE.md` are prose-only (codegen inserts the reference block).

## Backward compatibility

All existing apps are untouched: no `Pane.define` signature change, `MillerColumns`
gains an optional prop (existing mounts unaffected), `PaneOverlayHost` stays.
Only Sonata's own files change. New checks to expect to pass: plugin-boundaries
(host imports two sibling renderers via their `web` barrels — legal), no authored
`id:` in barrels, `text-3xs` not `text-[10px]`, plugins-doc-in-sync (run
`./equin build`).

## Verification (e2e)

`./equin build`, then adapt `e2e/screenshot.mjs` into a flow against
`http://<worktree>.localhost:9000`:
1. `/sonata` → library renders (empty route → index pane).
2. Click a song card → assert `page.url()` matches `/sonata/song/<id>`, the
   full-surface player renders (no columns), Display + transport + `SectionPane`
   present.
3. **Reload** `/sonata/song/<id>` → player restores (resolve hydrates sources,
   Loading → player). Proves persistence.
4. Browser **back** → `/sonata`, library shown. **Forward** → player again.
5. ← Library button from a deep-linked player → `/sonata`, library.
6. Regression: an existing Miller app (`/debug` or agent-manager) still renders
   columns; open the theme customizer there and in Sonata.

## Risks / notes

- **`songOpenEpoch` once-per-open** is the subtlest behavioral migration — bump
  it on player-pane **mount**, verify `playback-history` still records exactly
  one play per open (not zero, not double).
- **No public empty-route nav** → `clearChain()` is the fix; keep it generic.
- **Theme customizer full-surface in Sonata** is the one accepted behavior
  change (was a float). Consistent with Miller; flagged above.
- **Double-resolve** avoided by the optional-`match` prop contract: the host
  resolves once and provides context; inner renderers consume it.

## Critical files
- `plugins/primitives/plugins/pane/web/pane.ts` (+ `web/index.ts`) — `usePaneRoute`, `clearChain`
- `plugins/layouts/plugins/full-pane/web/**` (new) — `<FullPane/>`
- `plugins/layouts/plugins/host/web/**` (new) — `<PaneLayoutHost full={[…]}/>`
- `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` — optional `match` prop
- `plugins/apps/plugins/sonata/plugins/shell/web/panes.tsx` (new) — library + player panes, resolve
- `plugins/apps/plugins/sonata/plugins/shell/web/components/sonata-layout.tsx` — mount `<FullPane/>`
- `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` — drop `view`, re-home open-state + transport publish
- `plugins/apps/plugins/sonata/plugins/library/web/hooks.ts` — `useOpenSong` → `openPane(…, {mode:"root"})`
- `plugins/apps/plugins/sonata/plugins/shell/web/index.ts` — register both panes
