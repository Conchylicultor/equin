# Global tab-bar action bar (with pin) + remove Agent Manager toolbar

## Context

Today the shared action set (`ActionBar.Item` buttons — health, build, improve, theme,
notifications, screenshot, placement control, …) has **two homes** depending on the app:

- A **floating bar** (`shell/floating-bar`) fixed at `top-2 right-3`, mounted globally via
  `Core.Root`, but **hidden** on the Agent Manager (`activeApp?.hostsToolbar`).
- The **Agent Manager's own top toolbar** (`Shell.Toolbar` → `ActionBarStrip`), which renders the
  same buttons inline, plus the worktree label (`worktree-switcher`).

This split means the action set is "per-app": floating on most apps, inline-toolbar on the Agent
Manager. The goal is **one global action bar, integrated directly into the tab bar** (which already
renders above every app), shown identically everywhere — no floating widget, no per-app toolbar.

Additional requirements (confirmed with user):

- **Persistent pin** (localStorage): unpinned = collapsed to a status glyph that **auto-expands as
  an overlay on hover**; pinned = **stays expanded inline** (tab strip compresses around it). A pin
  button toggles the state.
- **Move the worktree-switcher** into this global bar.
- **Remove the Agent Manager's dedicated top toolbar entirely.** Its sidebar-collapse hamburger
  (the only visible `SidebarTrigger`, which lives in that toolbar) relocates to a **floating
  trigger in the Agent Manager main area** so it stays visible/reachable whether the sidebar is open
  or collapsed.

## Design decisions (resolved)

1. **Bar component = two visual branches sharing one inner content fragment.**
   - *Unpinned:* reuse the `FloatingAction` primitive (`anchor="top-right"`, absolute overlay) — the
     collapsed glyph sits in-flow at the trailing edge; hover expands the action row **leftward over
     the tab strip without reflowing it** (proven, matches today's floating bar).
   - *Pinned:* render the same content **inline** (real width); the tab strip compresses via its
     existing `min-w-0 overflow-x-auto`.
2. **Home = the `action-bar` plugin** (it already owns the `ActionBar.Item` slot). The component, the
   status hook, and the `enabled` config move here; the `floating-bar` plugin is **deleted**.
3. **Worktree-switcher becomes a plain `ActionBar.Item`** (not a named import into the bar). This
   honors collection-consumer separation **and dissolves the import cycle** that a direct import would
   create (`action-bar → worktree-switcher → action-bar`). It renders generically inside
   `<ActionBar.Item.Render/>`; its position follows registry order.
4. **Sidebar toggle = floating `SidebarTrigger` in the Agent Manager main area**, inside
   `SidebarProvider` but outside the collapsing sidebar, so it's always visible/reachable.
5. **Drop the `--floating-bar-safe-area` var.** The bar no longer overlaps app headers, so nothing
   publishes it. The `pr-floating-bar` utility harmlessly falls back to `--chrome-pad-x`; leave the
   utility/lint as-is (renaming is out of scope).

## Implementation steps

### 1. New global bar component — `action-bar`
Create `plugins/shell/plugins/action-bar/web/components/global-action-bar.tsx`:

- `const [pinned, setPinned] = useDraft<boolean>("action-bar-pinned", false, { ttl: <~10y> })`
  (`@plugins/primitives/plugins/persistent-draft/web` — confirm `useDraft(key, initial, {ttl})`
  signature; default ttl is 7d, so pass a large ttl for a permanent pin).
- `const { enabled } = useConfig(actionBarConfig)`; `if (!enabled) return null`.
- `const status = useActionBarStatus()`.
- A shared `BarContent` fragment = **status glyph** (`MdAutoAwesome` + `StatusDot`, tooltip from
  `status`) followed by the **expanding row**: `<ActionBar.Item.Render/>` + a **pin `IconButton`**
  (`MdPushPin`/`MdOutlinePushPin`, label "Pin/Unpin action bar", `onClick: () => setPinned(p=>!p)`).
- **Pinned branch:** `<div className="flex items-center gap-sm shrink-0">` → glyph + inline row (no
  fade wrapper).
- **Unpinned branch:** `<FloatingAction className="relative shrink-0" anchor="top-right"
  variant="ghost" panelClassName="items-center">` → glyph (always visible) + a
  `<FloatingActionFadeIn className="… max-w-0 … group-data-hovered/fa:max-w-[40rem]">` wrapping the
  action row + pin button. Reuse the exact transition classes from current `floating-bar.tsx:78-80`.
  Note: switch `fixed top-2 right-3 z-popover` → `relative` so the wrapper reserves its collapsed
  footprint in-flow inside the tab-bar flex row.

### 2. Move status hook + config into `action-bar`
- Create `web/internal/use-action-bar-status.ts` — port `floating-bar/web/internal/use-floating-bar-status.ts`
  verbatim, renamed (`useActionBarStatus`, `ActionBarStatus`/`StatusTone`). Its deps (`live-state`,
  `shell/notifications` notificationsResource, frontend-hash resource) are all legal from `action-bar`.
- Create `shared/config.ts` — port `floatingBarConfig` → `actionBarConfig` (drop `FLOATING_BAR_GUTTER`).
  Reword label/description: "Show the global action bar in the tab bar" (drop "floating / except Agent
  Manager").
- Create `server/index.ts` — `ConfigV2.Register({ descriptor: actionBarConfig })`
  (`@plugins/config_v2/server`). `action-bar` has no server barrel today; add one and the matching
  `package.json` server export if runtimes are gated there (verify during impl).

### 3. Wire the bar into the tab bar — edit `action-bar/web/index.ts`
- **Remove** the `Shell.Toolbar` contribution + `Shell` import + `ActionBarStrip` (delete
  `web/components/action-bar-strip.tsx`).
- **Add** `Apps.TabBarActions({ id: "global-action-bar", component: GlobalActionBar })`
  (`@plugins/apps/web`) and `ConfigV2.WebRegister({ descriptor: actionBarConfig })`
  (`@plugins/config_v2/web`). Keep `export { ActionBar } from "./slots"`.
- Coexists with the `surface` plugin's `TabBarPlacementControl` (also in `Apps.TabBarActions`) — both
  render where `AppTabBar` calls `<Apps.TabBarActions.Render/>`; place the action bar last (rightmost).
  The `surface` `ActionBarPlacementControl` (an `ActionBar.Item`) still renders inside the bar.

### 4. Delete the floating-bar plugin
Delete `plugins/shell/plugins/floating-bar/` entirely (web/server/shared/CLAUDE.md/package.json).

### 5. Relocate worktree-switcher → `ActionBar.Item`
Edit `plugins/apps/plugins/agent-manager/plugins/worktree-switcher/web/index.ts`:
- `Shell.Toolbar({…})` → `ActionBar.Item({ id: "worktree-switcher", component: WorktreeDropdown })`.
- Swap import `Shell` (`@plugins/shell/web`) → `ActionBar` (`@plugins/shell/plugins/action-bar/web`).
- Note in description/CLAUDE.md: now global chrome — candidate for a future move out of the
  agent-manager namespace (don't move now; path-derived-id churn for no functional gain).

### 6. Remove the Agent Manager toolbar + floating sidebar trigger
Edit `plugins/apps/plugins/agent-manager/plugins/shell/web/components/agent-manager-layout.tsx`:
- Drop `toolbarSlot={Shell.Toolbar}` (so `AppShellLayout` renders **no** toolbar header — confirmed
  clean collapse, no empty DOM).
- Wrap `children` to add a floating `SidebarTrigger` at the top-left of the main area, e.g.
  `children={<><AgentManagerSidebarToggle/><MillerColumns/></>}` where the toggle is a small
  `absolute`-positioned `<SidebarTrigger/>` (`@plugins/primitives/plugins/ui-kit/web`) with bg + a
  semantic z-layer. It's inside `SidebarInset` → `SidebarProvider`, so `useSidebar()` resolves and it
  stays visible in both open and collapsed (offcanvas) states. Tune position so it doesn't fight the
  first Miller column header.
- Remove the `Shell` import if now unused.

Edit `plugins/apps/plugins/agent-manager/plugins/shell/web/index.ts`: remove `hostsToolbar: true`.

Edit `plugins/apps/web/slots.ts`: remove the `hostsToolbar?: boolean` field + doc comment from
`Apps.App` (only consumer was the deleted floating bar; grep to confirm no other reader).

### 7. Build + checks + docs
- `./equin build` — regenerates `web.generated.ts` / `server.generated.ts` after the plugin
  delete + new `action-bar` server barrel (`plugins-registry-in-sync`).
- `./equin check plugin-boundaries` — confirm DAG stays acyclic (new legal edges:
  `action-bar → apps`, `worktree-switcher → action-bar`; no back-edge), one-barrel-per-runtime,
  registry exclusivity, barrel purity.
- `plugins-doc-in-sync`: update hand-written prose in `action-bar/CLAUDE.md` (now owns the global bar
  + status hook + config) and `shell/CLAUDE.md` (drop `floating-bar` sub-plugin). `Shell.Toolbar` now
  has **zero** contributors — **keep the slot defined** for now (removing a slot is a larger API
  change); flag as a possible follow-up cleanup.
- Run `no-adhoc-*` lints (spacing/radius/control-size/z-index) on the new component.

## Files

**Create:** `action-bar/web/components/global-action-bar.tsx`,
`action-bar/web/internal/use-action-bar-status.ts`, `action-bar/shared/config.ts`,
`action-bar/server/index.ts`

**Edit:** `action-bar/web/index.ts`, `action-bar/package.json` (server export if gated),
`agent-manager/worktree-switcher/web/index.ts`,
`agent-manager/shell/web/components/agent-manager-layout.tsx`,
`agent-manager/shell/web/index.ts`, `apps/web/slots.ts`

**Delete:** `plugins/shell/plugins/floating-bar/` (whole dir),
`action-bar/web/components/action-bar-strip.tsx`

## Verification (Playwright + build)

After `./equin build` (app at `http://att-1781459332-dbtj.localhost:9000`):

1. **Non-agent-manager app** (e.g. `/home`): tab bar shows the collapsed status glyph at the trailing
   edge; hovering expands the action row **leftward as an overlay** (tabs don't shift); clicking the
   pin keeps it **expanded inline** (tabs compress); reload → pin persists (localStorage
   `action-bar-pinned`).
2. **Agent Manager** (`/agents`): **no** top toolbar header; the global action bar appears in the tab
   bar (single mount, no duplication); the worktree label renders among the actions; the floating
   sidebar trigger is visible and toggles the sidebar (open **and** collapsed); `Cmd/Ctrl+B` also
   toggles.
3. **Surface controls intact:** `TabBarPlacementControl` next to `+`; `ActionBarPlacementControl`
   inside the expanded bar — both still function.
4. **No phantom gutter:** app headers no longer reserve right-padding for a (now absent) floating bar.

Use `e2e/screenshot.mjs --url … --click …` to capture before/after of hover-expand, pin, and the
agent-manager toolbar removal.
