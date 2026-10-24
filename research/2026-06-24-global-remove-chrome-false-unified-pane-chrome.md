# Remove `chrome: false` — Unify Every Pane Under `PaneChrome`

**Date:** 2026-06-24
**Category:** global (pane primitive + ~15 consumer panes across studio / settings / config / deploy / conversations / tasks / pages / prototypes / story / sonata)

## Context

`PaneChrome` is the standard pane shell. When enabled it bundles **three** things: (1) a header `Bar` (title + `Actions` slot + promote + close), (2) the pane body's single scroll container (`PaneScroll`) + `ContentScope` (Ctrl+A select-scope), and (3) nav/replace + `keepMountedWhenCollapsed` plumbing. `chrome: false` was the escape hatch for full-surface panes that render their own UI — but it is implemented as one `enabled: false` flag that short-circuits `PaneChrome` (`pane-chrome.tsx:66`), silently dropping **all three** concerns, including the body scroll.

That conflation is a footgun:
- It already caused **two unscrollable-pane bugs** — `studio/compositions` (fixed in this branch) and `studio/release` (still latent) — where a `chrome: false` pane forgot to re-add its own `<PaneScroll>`.
- **7 panes** carry a *dead no-op* `<PaneChrome title="…">` wrapper whose title/close/scroll are all silently discarded — misleading code that looks like it provides a header+scroll but provides nothing.
- The look is inconsistent: studio/settings side-panels that clearly *want* the standard titled header suppress it.

**Goal:** remove `chrome: false` entirely. Every pane uses `PaneChrome`, which **always** provides exactly one body scroll + `ContentScope` and a consistent header. The footgun is eliminated structurally (no flag can ever strand scrolling again). Rich custom toolbars (sonata player, story editor) fold into the same single header bar.

**Decisions (user-confirmed):**
- **Rich headers:** full unify — sonata/story toolbars become THE pane header at the standard `h-chrome-pane` height (one bar, no second row); sonata's full-width Transport progress strip moves into the body top.
- **Rollout:** staged — Stage 1 lands the primitive change + all 13 simple panes; Stage 2 converts the two rich panes (sonata player, story editor) and retires `definePaneToolbar.Host`. Sonata/story keep their existing toolbars working until Stage 2.

## Design — the unified header model

Chosen approach (**Option a**): fold `definePaneToolbar`'s reorderable `Start`/`End` render-slot zones **into** `PaneChrome` as an opt-in header. A pane's header content becomes composable:

- **Default header:** today's layout — `[sidebarToggle?] [title] [Actions:left] [OverflowActionsBar:right] [promote] [close]`.
- **Custom header (opt-in via `chrome.header`):** `[sidebarToggle?] [Start.Render] [spacer] [End.Render] [promote] [close]` — **no `OverflowActionsBar`**, so rich End widgets (transport / volume / jog-wheel) never collapse into a "⋯" popover.

Both render inside the same `<Bar tier="pane">`. The rich panes differ only in *what fills the bar*, not in bar height, structure, or the body wrapper. This is what makes the look consistent while keeping the sonata player's cross-plugin toolbar intact.

**Why not the alternatives:** (b) two stacked bars makes sonata/story the only double-height panes (contradicts the consistency goal) and leaves `definePaneToolbar` as a parallel header system. (c) routing rich widgets through `pane.Actions` `position:"right"` fails because that path always overflow-collapses.

**Cross-plugin contributors are untouched.** `transport-bar`, `audio/engine`, `piano-roll`, and `library` keep `import { SonataToolbar } from "@plugins/apps/plugins/sonata/plugins/shell/web"` and `SonataToolbar.End({...})`. `definePaneToolbar` still *defines* the `Start`/`End` zones; only its `Host` component (the separate `<Bar tier="chrome">`) is retired — `PaneChrome` becomes the host.

## Critical files

- `plugins/primitives/plugins/pane/web/pane.ts` — `PaneChromeConfig`/`NormalizedChrome`, `normalizeChrome` (:1141), nav `replace` (:546/:590/:1523), `DefineArgs` (:1179) / `RouteDefineArgs` (:1223).
- `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` — delete short-circuit (:66), add custom-header branch.
- `plugins/primitives/plugins/pane-toolbar/web/internal/define-pane-toolbar.tsx` — keep `Start`/`End`, lift the `ToolbarItem` renderer for reuse, deprecate/remove `Host`.
- `plugins/layouts/plugins/full-pane/web/components/full-pane.tsx` — provide a non-null `PaneLayoutContext`.

---

## Stage 1 — Primitive change + 13 simple panes

### 1a. Primitive: always-on chrome + body scroll

`pane.ts`:
- `PaneChromeConfig` (:108): add `header?: PaneHeaderZones`. To avoid a DAG cycle (pane must NOT import pane-toolbar), define `PaneHeaderZones` **structurally in pane** — duck-typed on the slot's `.Render` (e.g. `{ Start: { Render: ComponentType<…> }; End: {...}; controlSize?: ControlSize }`). pane-toolbar keeps depending on pane/bar; nothing depends back.
- Drop `| false` from `chrome?:` in `DefineArgs` (:1179) and `RouteDefineArgs` (:1223).
- `normalizeChrome` (:1141): remove the `chrome === false` branch and the `enabled` field:
  ```ts
  return { title: chrome?.title, header: chrome?.header,
           history: chrome?.history ?? true, close: chrome?.close ?? true,
           promote: chrome?.promote ?? true,
           keepMountedWhenCollapsed: chrome?.keepMountedWhenCollapsed ?? false };
  ```
- Remove `enabled` from `NormalizedChrome` (:135) and the cast at :1296.
- Nav `replace` (:546/:590/:1523): `enabled && !history` → `!history`. **Verified behavior-preserving:** `chrome:false` panes defaulted to `history:true` → `replace=false` (same as old `enabled:false`); `history:false` panes already had `enabled:true`. No nav change.

`pane-chrome.tsx`:
- Delete the `if (!chrome.enabled) return <>{children}</>` short-circuit (:66).
- Add the custom-header branch inside the `<Bar tier="pane">`: when `chrome.header` is set, render `Start`/`End` zones (reuse the lifted `ToolbarItem` + `ml-auto` End cluster from `define-pane-toolbar.tsx`) instead of the `title` / `PaneActionsSlot` / `OverflowActionsBar` triplet; `promote`/`close` still render after.

### 1b. FullPane sidebar-toggle fix

`full-pane.tsx:36` — `FullPane` currently sets `PaneLayoutContext = null`, so a full-surface pane's header would lose the sidebar toggle + floating-action-bar safe area (`showLeading`/`reserveEnd` need `layoutCtx.atSurfaceStart`/`atSurfaceEnd`). A full-pane surface is both the start and end edge:
```tsx
<PaneLayoutContext.Provider value={{ onDoubleClickHeader: () => {}, atSurfaceStart: true, atSurfaceEnd: true }}>
```
Do **not** touch the `showLeading`/`reserveEnd` conditions in `pane-chrome.tsx` — Miller columns set start/end per-column and must keep working.

### 1c. Per-pane conversions (remove dead wrappers + inner scroll; chrome owns the title)

Each pane: delete `chrome: false`; for Category B, delete the dead `<PaneChrome>` re-wrap (keep a `chrome: { title }` on the `Pane.define`); remove the body's own scroll so there's exactly one (`PaneScroll`).

**Category B (dead no-op wrapper today):**
- `studio/explorer` — `explorer-view.tsx:46/59`: drop inner `<PaneScroll>`. Pane: `chrome: { title: "Explorer" }`.
- `studio/compositions` — `compositions-view.tsx:236/282`: drop the `<PaneScroll>` added earlier in this branch. Pane: `chrome: { title: "Compositions" }`.
- `studio/contributions` — `contributions-view.tsx:86`: `<Column fill>` → `<Column fill scrollBody={false}>` (DataTable body becomes the flexible region; facet strip + search stay as `header`). Pane: `chrome: { title: "Contributions" }`.
- `studio/graph` — already `<Column scrollBody={false}>` (canvas); no scroll change. Pane: `chrome: { title: "Plugin Graph" }`. (Canvas under inert `PaneScroll` is fine — `h-full` fills exactly.)
- `studio/release` — `release-launcher.tsx:214` is a plain `<Stack h-full>` with **no scroll** (the latent bug). Converting to chrome auto-fixes it; remove nothing. Pane: `chrome: { title: "Release" }`.
- `settings/config index` + `config_v2/settings nav` — shared `config-nav.tsx:202`: drop the `<PaneScroll>` around `<DataView>` (one edit fixes both panes). Panes: `chrome: { title: "Config" }`.

**Category A (own UI, no dead wrapper):**
- `conversations/agents` `AgentsRoot` — `agents/web/panes.tsx:63`: drop `<Scroll axis="both" h-full p-lg>`, move `p-lg` onto content (verify horizontal scroll isn't needed; if it is, keep a narrow inner `<Scroll axis="x">` on the wide child only). Pane: `chrome: { title: "Agents" }`.
- `tasks/task-detail` `TasksRoot` — `<Tasks.Host>` is a `tabbedView` = `<Column fill>` with a managed scroll body. Leave it as-is and let the outer `PaneScroll` stay inert (`h-full` fills exactly — documented safe pattern). Pane: `chrome: { title: "Tasks" }`. Verify no double scrollbar.
- `pages/welcome` `PagesRoot` — `panes.tsx:25`: drop `<Scroll h-full>`; drop the in-body `<h1>Pages</h1>` (:29) in favor of `chrome: { title: "Pages" }`; keep the subtitle paragraph as body intro.
- `prototypes/gallery` — `prototype-gallery.tsx:97`: drop `<PaneScroll>`; remove DataView `title="Prototypes"` (:99); Pane: `chrome: { title: "Prototypes" }`.
- `deploy/servers` (was missing from the original audit list — **include it**): `panes.tsx:46` `<Stack h-full>` wrapping `<ServersList>` (a DataView that owns its own scroll). Convert: `chrome: { title: "Servers" }`, drop the `<Stack h-full>`, disable any inner scroll so there's exactly one.

### 1d. Stage 1 tests / lint

- `pane-isolation.test.tsx:31` and `pane-restore-isolation.test.tsx:34,41`: drop the `chrome: false` fixture lines (components render `() => null`, so an empty header is harmless).

---

## Stage 2 — Rich panes (sonata player, story editor) + retire `definePaneToolbar.Host`

### 2a. Story (simpler)
- `story/shell` gallery `StoryGallery` — `story-gallery.tsx:60`: drop the `<Column fill body={DataView}>`; place `<DataView>` directly as PaneChrome children (DataView manages its own list virtualization inside `PaneScroll`); remove DataView `title="Stories"`. Pane: `chrome: { title: "Stories" }`.
- `story/shell` editor `StoryEditor` — `story-editor.tsx:20`: replace the bespoke `<Column header={<StoryToolbar.Host/>} scrollBody={false} body={…}>` with default chrome via `chrome: { header: StoryToolbar }` on `storyDetailPane`. `StoryEditorBody`'s independent split panels (each `overflow-y-auto`) stay; they live under an inert `PaneScroll` (`flex-1 min-h-0` fills exactly). Verify split panels still scroll independently.

### 2b. Sonata (riskiest)
- `sonata/library` `SonataLibrarySurface` — `library-surface.tsx:11`: drop the `<Column scrollBody={false} body={Sonata.Home.Render}>`; place `Sonata.Home.Render` directly in PaneChrome (its DataView owns scroll). Pane: `chrome: { title: "Library" }`.
- `sonata/library` player `SonataPlayerSurface` — `panes.tsx:144`: replace `<Column header={<><SonataToolbar.Host/><Sonata.Transport.Render/></>} body={display}>` with default chrome via `chrome: { header: SonataToolbar }` on `sonataPlayerPane`. The **second header row** (`Sonata.Transport.Render` progress strip) moves to the **body top** as the first child (above the display). Display is a canvas (`scrollBody={false}`) so `PaneScroll` stays inert.

### 2c. Retire the Host + docs/lint
- `define-pane-toolbar.tsx`: remove `Host` from the `PaneToolbar` interface + factory (zones remain).
- `no-adhoc-pane-toolbar.ts`: keep the rule (still bans hand-rolled `border-b`+`pr-floating-bar` bars); update its message to point at `chrome: { header }` instead of `<Toolbar.Host/>`. `bar/no-adhoc-bar` unaffected.
- Docs: `pane/CLAUDE.md` (remove the `chrome: false` opt-out section; document `chrome.header`), `pane-toolbar/CLAUDE.md`, `full-pane/CLAUDE.md` (drop "honors `chrome:false`").
- Decision deferred to follow-up: rename `definePaneToolbar` → `definePaneHeader` (keep the name this round to minimize churn).

---

## Verification

Run `./equin build` after each pane (Stage 1) and after each rich pane (Stage 2); `./equin check` at the end of each stage.

**Scripted Playwright checks** (use `e2e/screenshot.mjs` pattern; app at `http://<worktree>.localhost:9000`):

- **Scroll guarantee / no double scroll** — for each converted pane (`/studio/compositions`, `/studio/release`, `/studio/explorer`, `/studio/contributions`, `/settings/config`, `/agents`, `/tasks`, `/pages`, `/prototypes`, deploy servers): assert exactly **one** scrollable `overflow-y-auto` ancestor in the pane body (`scrollHeight > clientHeight` on the `PaneScroll`, and no nested second scroller). This is the same assertion used to confirm the compositions fix earlier in this branch.
- **Consistent header** — assert each converted pane now renders a header `Bar` with its title (e.g. "Explorer", "Release", "Config").
- **Full-surface sidebar toggle** (Stage 1b) — open `/pages`, `/prototypes`, `/agents`; assert the sidebar-toggle button is present at the header's leading edge and the floating-action-bar safe area (`pr-floating-bar` / `endSafeArea`) is reserved (no overlap with the top-right floating bar).
- **Sonata player (Stage 2, riskiest)** — open `/sonata`, click a song: assert **one** header strip (not two), the transport / volume / jog-wheel widgets are visible and **not** behind a "⋯" popover, the Transport progress strip renders **below** the header (body top), and the display fills/scrolls. Drag-resize the window narrow and re-screenshot to confirm the End widgets don't collapse or clip.
- **Story editor (Stage 2)** — open a story, confirm one header bar (back + title + view-switcher), and the split panels scroll independently.

## Risks

- **Sonata header height** — rich `sm`-density widgets in the shorter `h-chrome-pane` bar; verified via the narrow-window Playwright pass. Any genuinely-cramped widget is a per-widget fix, not a reason for a taller bar (consistency decision is locked).
- **Inert-outer scroll panes** (tasks `Tasks.Host`, story split, sonata display) — the outer `PaneScroll` is inert because the inner content fills exactly; confirm no stray second scrollbar and that `VirtualRows.findScrollParent` binds to the intended scroller.
- **DAG** — `PaneHeaderZones` must be defined structurally in `pane` (not imported from `pane-toolbar`) to avoid a cycle.
