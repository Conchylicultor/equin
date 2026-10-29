# Pane → app morph on "Open in <App>"

## Context

A pane's Expand button (`Pane.define({ expand })`, or the default cross-app promote)
replaces the focused tab's app with another one (`navigate` → `replaceTabAppWithRoute`).
Today that is an instant swap. The prototype `proto-1793274267-ojlxu9` (variant: morph,
instant start, sidebar swap) settled the look: the pane **morphs from its box to its place
in the new app**, the old app recedes (scale .96, blur, fade), the new one rises, the two
apps' sidebars cross-fade in place, the header title glides, snapshots are cropped (never
stretched), ~440 ms, starting the frame after the click.

Built on the View Transitions API: the old app's DOM is captured as an image, the new app
mounts from scratch (it is a different component tree — `rebuildTabApp` replaces the tab's
app and store under the same `tabId`), and named elements on both sides morph.

## Findings that shape the design

- The click path is synchronous: `linkProps` → `LinkTarget.open()` → tabs `navigate()` →
  `useState`/module-store writes. `flushSync` inside the `startViewTransition` callback
  commits the new app (React 18 flushes passive effects of a sync commit too).
- The old app is **not** kept alive — the same tab container (`TabContainer`, keyed and
  `data-tab-id` stamped in `surface-body.tsx`) switches its app. The tab container is the
  scope both "old" and "new" live in.
- Matching panes: page → Pages and prototype → Prototypes render the **same** pane id on
  both sides; file-peek → Files lands on `files-at` (a different pane). So the new-side
  match is **the leaf pane of the new route**, not "same pane id".
- Stable DOM contracts already exist: `PaneBox` stamps `data-pane-id`; the header title is
  `data-part="pane.title"`; every app sidebar is the ui-kit `Sidebar`
  (`data-slot="sidebar-container"`), Prototypes has none (its old sidebar just leaves with
  the old app).
- No `startViewTransition` anywhere yet; one global stylesheet (`ui-kit/web/theme/app.css`).
- **Finding from the prototype:** removing/replacing a named element mid-transition aborts
  it. We only name elements that persist while the new app loads (the `PaneBox`, the
  header title, the sidebar container) — `Loading` → content swaps happen inside them.
- No generic prefetch substrate: plugin code is all loaded at boot (eager, then deferred
  tier), and live data has no imperative warm API. The panes that morph today read keys the
  source pane already holds (page, prototype) — the cache serves the new app's first render.

## Design

### 1. The seam — `paneMorphSink` (pane primitive)

Like `appNavSink`: the pane layer cannot import apps-core, so apps-core installs the
implementation.

`plugins/primitives/plugins/pane/web/morph-sink.ts`

```ts
export interface PaneMorph {
  /** Run `open` (a cross-app navigation) as a morph out of `from` (the pane's box). */
  (from: HTMLElement, open: () => void): void;
}
export const paneMorphSink = defineInstallSink<PaneMorph>({ name: "pane.morph", … });
```

`PaneBox` exposes its element through a small context (`usePaneBoxElement()`), so the
expand control reads its own box — no `closest()` query.

`promote-control.tsx`: for a **cross-app** target only (`ExpandElsewhere` ready, or
`DefaultPromote` `kind: "cross-app"`), a plain activation becomes
`morph ? morph(box, target.open) : target.open()`. Modifier/middle clicks keep
`linkProps`' new-browser-tab behaviour. Same-app re-root is untouched.

### 2. Activation stays on click (decided)

The morph starts on the ordinary click — the user keeps press-and-drag-away to cancel. The
start is still immediate after release: `update` is synchronous (no waiting for data), so
the morph's first frame is the next frame.

### 3. The implementation — new plugin `plugins/apps-core/plugins/pane-morph` (web)

Installs `paneMorphSink` at `Core.Root` mount. `morph(from, open)`:

1. Bail to a plain `open()` when: no `document.startViewTransition`,
   `prefers-reduced-motion`, a transition already running, or `from` is not inside a
   focused tab container.
2. Name the old side: `from` → `pane-morph`, its `[data-part="pane.title"]` →
   `pane-morph-title`, the tab's `[data-slot="sidebar-container"]` → `app-sidebar`
   (inline `style.viewTransitionName`).
3. `document.startViewTransition({ update, types: ["pane-morph"] })` where `update`
   synchronously: clears the old names, `flushSync(open)`, then names the new side inside the
   same tab container — the leaf `PaneBox` of the focused tab's new route (read from tabs'
   focused store: last route entry id → `[data-pane-id="…"]`, last in DOM order), its title,
   its sidebar. Missing new-side element → that group just fades (no throw: an unresolved
   route whose pane plugin is still loading lands on the route fallback, and that is a fine
   ending).
4. On `finished`, clear the names. Names exist only for the duration of one morph, so
   windows mode (several visible tabs, several sidebars) can never produce duplicates.

Needs from tabs: an imperative read of the focused tab's id and route
(add to `apps-core/plugins/tabs/web` barrel if not already there), and `data-tab-id` on
`AppTabsBody`'s per-tab element too (today only `TabContainer` has it).

### 4. CSS — `pane-morph/web/morph.css` (imported by the plugin)

Scoped with `:active-view-transition-type(pane-morph)` so no other future transition
inherits it:

- every `::view-transition-old/new(*)`: `width/height: auto; object-fit: none;
  object-position: left top` (crop, never stretch);
- `group(pane-morph)`: `overflow: clip; background: var(--background)`;
  `old(pane-morph)` fades in 40 % of the duration (no long double exposure of the reflow);
- `old(root)`: recede (scale .96, blur 2px, fade); `new(root)`: fade in;
- duration 440 ms, `cubic-bezier(.25,.8,.25,1)` — as `--pane-morph-duration/easing`
  custom properties next to the existing motion tokens;
- `prefers-reduced-motion` is handled in JS (step 3.1), so nothing animates.

### 5. Prefetch on hover — deferred

No generic substrate exists, and the morphing panes today need none (their data is already
cached by the source pane). Hover prefetch becomes a follow-up: a `Pane.define({ prefetch })`
hook the expand control calls on `pointerenter`, once a pane appears whose target is slow.

## Files

- `primitives/plugins/pane/web/morph-sink.ts` (new), `web/index.ts` (export),
  `web/components/pane-box.tsx` (element context), `web/components/promote-control.tsx`
- `apps-core/plugins/pane-morph/` (new: `web/index.ts`, `web/internal/morph.ts`,
  `web/morph.css`, `CLAUDE.md`)
- `apps-core/plugins/tabs/web` (focused tab/route read, if missing),
  `apps-core/plugins/tab-surface/web/components/app-tabs-body.tsx` (`data-tab-id`)

## Verification

- `./equin test plugins/primitives/plugins/pane plugins/apps-core/plugins/pane-morph` — jsdom: a plain click on a cross-app Expand calls the
  installed morph with the pane's box, ⌘/middle-click still opens a browser tab, no morph
  installed → plain `open()`; the morph falls back to plain `open()` without
  `startViewTransition`, and its names are cleared after a (stubbed) transition.
- `./equin check`, `./equin build`.
- e2e `apps-core/plugins/pane-morph/e2e/morph.ts`: open a conversation with a page pane
  and one with a file pane, press Expand, assert a view transition ran with `pane-morph`
  on both sides (`document.getAnimations()` pseudo-elements), it was not skipped, and the
  route is the target app's; screenshots mid-flight (animations paused) and at the end.
- Manual look via `browser_*` on the worktree build at the three expand sites (file → Files,
  page → Pages, prototype → Prototypes).
