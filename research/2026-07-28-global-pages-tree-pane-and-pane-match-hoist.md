# Pages tree as a pane + hoisting `PaneMatchContext` to the surface

Date: 2026-07-28 · Category: global

## Context

Two independent changes, packaged together because they touch the same seam.

**Part A — the feature.** The Pages page tree today exists only as a `Pages.Sidebar`
contribution inside the Pages app. There is no way to browse pages from the agent
manager without switching apps. We want a button in the **conversation action bar**
that opens the page tree as a **Miller column beside the conversation**, with a
clicked page opening its detail as a further column to the right.

The clean way to build it is *not* to re-implement a tree: define a pane whose body
renders `Pages.Sidebar` — the same render slot the Pages app's `AppShellLayout`
paints. Search, tree and trash come along, and any future `Pages.Sidebar`
contribution appears in the pane for free. This is collection-consumer separation
applied literally: the pane consumes the slot generically and never names a
contributor.

**Part B — a pre-existing bug, fixed structurally.**
`plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx:37`
reads

```ts
const selectedId = pageDetailPane.useRouteEntry()?.params.pageId;
```

`useRouteEntry()` reads `PaneMatchContext` (`plugins/primitives/plugins/pane/web/pane.ts:1393-1399`),
whose default is `null` (`pane.ts:1179`). The `Provider` is mounted in exactly three
places — `layouts/miller/…/miller-columns.tsx:132`, `layouts/full-pane/…/full-pane.tsx:66`,
`layouts/host/…/pane-layout-host.tsx:34` — all of which render inside `AppShellLayout`'s
`children`, which the framing receives as its `body` prop. `sidebarContent` is a
**sibling** of `body` (`plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx:214-262`).
The sidebar is therefore structurally outside every match provider, and `selectedId`
is always `undefined`: **the active-page highlight in the Pages sidebar is dead
today**, and so are four sibling cases (enumerated below).

The match is a property of the **surface**, not of the layout renderer that happens
to paint the main area. Resolving it once in `PaneSurfaceProvider` — which already
receives exactly the two inputs needed (`store`, `basePath`) and already wraps the
whole app including sidebar and toolbar — makes the entire class of bug
unrepresentable and deletes the `match`-prop threading the three renderers carry
today.

Part A does **not** depend on Part B (see *Ordering*), but Part B is what makes the
same highlight work in the Pages app's own sidebar.

---

## Part A — `pagesTreePane`

### A1. The route

**Create** `plugins/apps/plugins/pages/plugins/page-tree/core/routes.ts` — add
alongside the existing `pageDetailRoute`:

```ts
export const pagesTreeRoute = defineRoute({ id: "pages-tree", segment: "pages-tree" });
```

Mirrors the newer `Pane.define({ route })` form already used by `pageDetailRoute`
(same file), `buildRoute`/`buildDetailRoute`, and `tasksRootRoute`/`taskDetailRoute`.
Export it from `page-tree/core/index.ts` next to `pageDetailRoute`.

Segment `"pages-tree"` is currently unclaimed (verified: no `segment: "pages*"`
anywhere). Uniqueness is enforced statically by `pane:segments-unique`
(`plugins/primitives/plugins/pane/check/index.ts:74`) and at runtime by
`useSyncPaneRegistry` (`pane.ts:1786-1797`).

No `:param` ⇒ **no `resolve` hook needed** (`resolve` is mandatory only for
parameterized panes).

### A2. The pane

**Modify** `plugins/apps/plugins/pages/plugins/page-tree/web/panes.tsx` — add
beside `pageDetailPane`:

```tsx
export const pagesTreePane = Pane.define({
  route: pagesTreeRoute,
  component: PagesTreeBody,
  width: 320,
});

function PagesTreeBody() {
  return (
    <PaneChrome pane={pagesTreePane} title="Pages">
      <Pages.Sidebar.Render>{(item) => <item.component />}</Pages.Sidebar.Render>
    </PaneChrome>
  );
}
```

- `Pages` is already imported into this plugin (`page-tree/web/index.ts:4`, from
  `@plugins/apps/plugins/pages/plugins/shell/web`). No new cross-plugin edge; no
  cycle (`pages/shell/web` imports only `apps-core`, `app-icon` and its own slots —
  never `page-tree`).
- The `{(item) => <item.component />}` render shape is copied verbatim from
  `app-shell-layout.tsx:245`, so the pane paints the slot exactly as the app does.
- **No `titleOwner`.** It is a nav column; `pageDetailPane` already declares
  `titleOwner: true`, so the tab title follows the opened page, which is right.
- `width: 320` — the repo's nav/list-column convention (`tasksRootPane` 320,
  `agentsRootPane` 320, `serversRootPane` 320, `definitionsPane` 320,
  `attemptPane` 320; detail panes run 480–900). 300 is also in-family
  (`configNavPane`); 320 is the mode.

**Register it** in `page-tree/web/index.ts`: add `Pane.Register({ pane: pagesTreePane })`
and `export { pagesTreePane } from "./panes";`.

#### Why the pane lives in `page-tree` and not `pages/shell`

`pages/shell` owns the `Pages.Sidebar` slot, so it is arguably the slot's natural
consumer. It is rejected because `pages/shell` is **structurally eager** (an app's
`shell` subtree is never deferred — `eager-tier-gen.ts:71-84`), and the sibling
column `pageDetailPane` already lives in `page-tree`. Keeping both panes in one
file keeps the pair legible and leaves the definition in the deferred tier where
app content belongs.

#### The three `Pages.Sidebar` contributors render fine in a pane body

Verified: `grep -rn "useSidebar\|SidebarMenu\|SidebarGroup\|SidebarProvider"
plugins/apps/plugins/pages/` returns **zero matches**. `PagesSidebar` is a
`Scroll` + `DataView`; `PagesSearch` and `PagesTrash` are a `Row` plus a dialog.
None needs a `SidebarProvider` ancestor.

#### `PagesSidebar` needs no change

It already calls `useOpenPane()` + `openPane(pageDetailPane, { pageId }, { mode: "push" })`.
Inside the pane, Miller provides `PaneInstanceContext` per column
(`miller-columns.tsx:100`), so `useOpenPane` takes the caller-aware branch
(`pane.ts:2011-2060`) and pushes `pageDetailPane` **to the right of the tree
column**. Its `selectedId` highlight also works immediately inside the pane
(Miller provides the match) — Part B is what fixes it in the *app sidebar*.

### A3. Why the trigger is the conversation action bar, not a sidebar entry

An earlier draft put a `Shell.Sidebar` entry in the agent-manager sidebar. That is
**dropped**: it cannot produce the route this feature is for.

A sidebar button has **no caller position** — the sidebar is a sibling of the
layout renderer's subtree, so it is outside every `PaneInstanceContext`. Both the
free `openPane()` and `useOpenPane()` therefore land in
`openPaneImpl(…, { root: false })`, and that path (`pane.ts:805-835`) does **not**
append to the current route: with the target absent from the route it rebuilds a
fresh route from `defaultAncestors`. So `mode: "push"` from a sidebar button
produces `[pagesTree]`, exactly like `mode: "root"` — the conversation is
*replaced*, never `[conversation] [pagesTree]`.

The trigger is therefore rendered **inside** the conversation pane, where it does
have a caller instance.

### A4. The conversation-toolbar button

**Create** `plugins/apps/plugins/agent-manager/plugins/pages-nav/` with
`package.json`, `CLAUDE.md`, `web/index.ts` and
`web/components/pages-tree-button.tsx`:

```ts
export default {
  description:
    "Pages entry point in the agent manager: a conversation-toolbar toggle that opens the Pages tree as a column beside the conversation.",
  contributions: [
    Conversation.ActionBar({ id: "pages", component: PagesTreeButton }),
  ],
} satisfies PluginDefinition;
```

`Conversation.ActionBar` comes from
`@plugins/conversations/plugins/conversation-view/plugins/action-bar/web`, and
`PagesTreeButton` copies the shape of
`plugins/code-explorer/web/components/conv-tree-button.tsx` — the existing
conversation-toolbar-opens-a-pane precedent — using `pagesTreePane.useToggle({})`.
Rendered inside the conversation pane, `useToggle`'s default `mode: "push"`
(`pane.ts:1469`) inserts the tree to the right → `[conversation] [pages tree]`,
and clicking a page → `[conversation] [pages tree] [page detail]`. `useToggle`
also gives free open/close state and an active-button style.

**Placement is deferred-tier-safe.** `apps/plugins/agent-manager/plugins/pages-nav`
matches `APP_CONTENT_RE` with `child !== "shell"` (`eager-tier-gen.ts:71-84`), and
`Conversation.ActionBar` is **not** in `WATCHED_SLOTS` (`Core.Root` / `Core.Boot` /
`Apps.App` / `ActionBar.Item`, `eager-tier-gen.ts:196-201` — note `ActionBar.Item`
is the *global* action bar, a different slot). It declares no `bootCritical`
descriptor. Nothing eager imports it. Empirical confirmation: the sibling
`apps/plugins/agent-manager/plugins/welcome` (same depth, only `Pane.Register`) is
in `DEFERRED_PLUGIN_PATHS` today, while `…/worktree-switcher` is pinned eager
*because* it hits `ActionBar.Item`. Importing `pagesTreePane` from the (deferred)
`page-tree` plugin adds a forward edge to a deferred plugin — the closure runs
forward from eager seeds, so this cannot pull us eager.

> ⚠️ **`./equin build` regenerates `web-tiers.generated.ts`.** Confirm
> `"apps/plugins/agent-manager/plugins/pages-nav"` lands in `DEFERRED_PLUGIN_PATHS`
> and that no new entry appears in the "pinned EAGER" comment block.

### A5. Explicitly out of scope

- The Pages app (`/pages`) is untouched — it keeps its `AppShellLayout` sidebar.
- No `defaultAncestors` added to `pageDetailPane`; existing open-from-elsewhere
  behavior is unchanged.

---

## Part B — hoist `PaneMatchContext` into `PaneSurfaceProvider`

### B1. The provider move

**Modify** `plugins/primitives/plugins/pane/web/pane.ts` (`PaneSurfaceProvider`,
line 1030).

> 🚩 **The trap.** `PaneSurfaceProvider` cannot call `usePaneRoute(basePath)` in its
> own body: hooks there run **above** the `PaneStoreContext.Provider` it renders, so
> `usePaneStore()` would read the *outer* context — `null` at the top level (throw),
> or a parent surface's store. The resolve must live in an inner component mounted
> **below** both `PaneStoreContext.Provider` and `PaneBasePathContext.Provider`.

`pane.ts` is a `.ts` file using `createElement`; keep that style:

```ts
function SurfaceMatchProvider({ basePath, children }: { basePath: string; children: ReactNode }) {
  const match = usePaneRoute(basePath);
  return createElement(PaneMatchContext.Provider, { value: match }, children);
}
```

Mount it as the innermost wrapper of `PaneSurfaceProvider`'s existing
`createElement` chain (inside `SurfaceIdContext.Provider`). `PaneSurfaceProvider`
itself stays hook-free; `SurfaceMatchProvider` is a component, so calling hooks
there is safe.

`PaneSurfaceProvider` is mounted exactly once per tab, at
`plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx:48-54`,
wrapping the entire `Apps.App.component` — sidebar, toolbar and main alike.

### B2. The three renderers become consumers

- **`plugins/layouts/plugins/miller/web/components/miller-columns.tsx`** — drop the
  `match?: PaneMatch` prop, drop `usePaneRoute`/`PaneBasePathContext`, replace with
  `const match = usePaneMatch();`. **Deletes** the "always run the self-resolve hooks
  to keep hook order stable … when a `match` prop is supplied we use it instead"
  dance (lines 19-28) and the conditional `provided ? body : <Provider>` tail
  (lines 126-133). `basePath` is still read for the `PluginErrorBoundary` label —
  keep that `useContext(PaneBasePathContext)`.
- **`plugins/layouts/plugins/full-pane/web/components/full-pane.tsx`** — same:
  drop the prop, the `usePaneRoute` call and the conditional provider tail
  (lines 37-40, 63-67).
- **`plugins/layouts/plugins/host/web/components/pane-layout-host.tsx`** — collapses
  to `const match = usePaneMatch();` + the `isFull` dispatch. **Deletes** the
  `PaneMatchContext.Provider`, the `usePaneRoute` call, the `PaneBasePathContext`
  read, and both `match={match ?? undefined}` threads. (It has zero production
  render sites today — it is exported API only.)

Also update `plugins/layouts/plugins/{miller,full-pane,host}/CLAUDE.md`: the
hand-written prose in each documents the `match` prop and "self-resolves the route
and provides `PaneMatchContext`", which stops being true. `plugins-doc-in-sync`
regenerates only the autogen block.

### B3. Ordering / timing consequences of moving the `usePaneRoute` write

`usePaneRoute` (`pane.ts:1909-1929`) is not a pure read — it performs
`store.setBasePath(basePath)` via `useRenderSync` (a **render-phase** write,
deliberately not an effect: `use-render-sync.ts:8-13`) and then `useSyncPaneRegistry()`,
which rebuilds the registry and calls `store.handleLocationChange()`.

Moving it up is a **strict improvement**, and the reason is the ordering:

- **Today**, within one surface render pass, `AppShellLayout` paints
  `sidebarContent` (inside `<Sidebar>`) *before* `body` (inside `<SidebarInset>`),
  so the sidebar renders **before** the layout renderer sets this surface's base
  path and syncs the registry. That is a second, independent reason sidebar route
  reads are unreliable.
- **After**, `SurfaceMatchProvider` runs the whole preamble before *any* of the app
  subtree renders. Base path set → registry synced → route resolved → children.

Two behavior deltas to check, both believed benign:

1. **Surfaces that mount no layout renderer now get `setBasePath` + registry sync.**
   Today only a surface whose app mounts `MillerColumns`/`FullPane` sets its own
   store's base path. Apps with a bespoke surface (browser, sonata, website, home)
   leave their store's `basePath` at `""`, which builds URLs missing the app prefix.
   After the hoist every surface sets it. This fixes a latent bug rather than
   creating one, but verify those four apps' navigation.
2. **Count of `handleLocationChange()` calls is unchanged** for surfaces that do
   mount a renderer (one per surface per registry change, `useRenderSync`-gated on
   the `Pane.Register` contributions identity — just moved up a level).

**`AppsLayout`'s own `useSyncPaneRegistry()`** (`plugins/apps-core/plugins/layout/web/components/apps-layout.tsx:159`)
must **stay**: it targets the *live* store from outside every surface so global
chrome (theme customizer, action bar) can `openPane` without "Unknown pane".

**`PaneOverlayHost`** (`plugins/layouts/plugins/miller/web/components/pane-overlay-host.tsx`,
rendered only by `apps/home/shell`) renders a nested `<MillerColumns/>`. After the
hoist that inner Miller reads the *hoisted* match instead of self-resolving. Same
store, same `basePath` ⇒ same match, so the render is identical. Its own guard
`if (!hasPane) return null` uses `useRoute()` (no index-pane fallback, deliberate),
which is untouched — so a bare app root still shows no overlay.
*Optional cleanup:* its `useRenderSync(() => setBasePath(basePath))` (line 29-31)
and `useSyncPaneRegistry()` (line 32) become redundant once the surface does both,
**and** its `setBasePath` is the free liveStore function rather than the surface
store — a latent inconsistency. Recommend deleting both lines in the same change;
if that feels like scope creep, leave them (they are idempotent) and file a task.

### B4. Blast radius — who *newly* sees a match

Verified by tracing every `Shell.Sidebar` / `<App>.Sidebar` / `sidebarNavItem`
contribution in the repo to its component and checking each for match-reading hooks.
`.Toolbar({` has **zero** hits repo-wide, so the toolbar half of the hoist is a
no-op today.

Exactly **five** components change behavior — all of them by starting to work:

| Component | Contribution | What it starts doing |
|---|---|---|
| `PagesSidebar` (`pages-sidebar.tsx:37`) | `Pages.Sidebar` "pages" | active-page highlight starts working |
| `DeletePageAction` (`delete-page-action.tsx:37`) | `PageTree.RowActions`, nested under `PagesSidebar` | correctly navigates off a deleted page that is currently open |
| `MailboxNav` via `useSelectedMailView` (`mailbox/web/internal/use-selected-mail-view.ts:8`) | `Mail.Sidebar` "mailbox" | active-view highlight starts working |
| `WorkflowsSidebar` (`workflows-sidebar.tsx:29`) | `WorkflowsApp.Sidebar` "definitions" | active-definition highlight starts working |
| `ConversationList` (`conversation-list.tsx:19`) | `Shell.Sidebar` "conversations" → `ConversationsSidebar` | active-conversation highlight starts working |

Every other match reader (`useRouteEntry`/`useRouteEntries`/`useParams`/`useOptions`/
`useHint`/`PaneChrome`) is inside a pane body and already sees the match today —
unchanged. `usePaneMatch()` and `useCurrentPane()` have **zero** external call sites.
`useOpenPane()` reads only `PaneStoreContext` + `PaneInstanceContext`
(`pane.ts:1988-1989`) — **not** the match — so navigation semantics are untouched
everywhere, including the sidebar.

⚠️ *Newly-live highlight code is newly-executed code.* Watch for a
`useRevealOnActive`/`scroll-into-view` in any of those five that has never fired
before and may now scroll a sidebar on first paint.

### B5. Should absence-of-provider throw? — yes, as a separate commit

**Recommend yes.** `useRouteEntry()` returning `null` on `!match` (`pane.ts:1395`) is
precisely the banned absorbable-failure shape: it conflates "there is no surface"
(a wiring bug — the very bug this plan fixes) with "this pane is not in the route"
(a legitimate answer). One is unrecoverable, one is normal, and today they are the
same value. That is why the Pages highlight died silently for as long as it did.

`null` cannot be the sentinel — it is a *legitimate* in-surface value (pending /
not-found route). Use a three-state context:

```ts
export const PaneMatchContext = createContext<PaneMatch | null | undefined>(undefined);

function useMatchOrThrow(): PaneMatch | null {
  const match = useContext(PaneMatchContext);
  if (match === undefined) {
    throw new Error(
      "No <PaneSurfaceProvider> in the tree: this component renders outside every " +
      "pane surface (global chrome such as the action bar), so it has no pane route " +
      "to read. Use navigate() from @plugins/apps-core/plugins/tabs/web instead.",
    );
  }
  return match;
}
```

Route `usePaneMatch`, `useCurrentPane`, `useOwnEntry`, `useRouteEntry`,
`useRouteEntries` and `useParams` through it. `useParams()` already throws on
`!match` (`pane.ts:1351-1355`) — its message ("called outside the pane layout
renderer") becomes wrong after the hoist and should be reworded to "outside the pane
surface". Mirrors `usePaneStore()` (`pane.ts:966-978`) exactly.

**Risk check.** The known out-of-surface caller,
`plugins/config_v2/plugins/config-link/web/internal/use-open-config.ts`, reads no
match — it deliberately uses `navigate()` (its comment at lines 14-20 names the
`no PaneSurfaceProvider` problem). No global-chrome component reads the match today.
The residual risk is an active-data chip (`plugin-link-chip.tsx:40`,
`task-card.tsx:157`) rendering inside a global-action-bar popover; React portals
preserve context, so only a genuinely out-of-surface mount would trip, and
`PluginErrorBoundary` contains it.

**Land B5 as its own commit after B1–B3 are verified**, so it can be reverted
independently if a chip surfaces in global chrome.

### B6. Tests

No test mounts `PaneSurfaceProvider`, `MillerColumns`, `FullPane` or
`PaneLayoutHost` as JSX. The four pane suites build a `PaneStoreContext.Provider`
by hand and call `usePaneRoute`/`useSyncPaneRegistry` in a probe component — both
signatures and semantics are unchanged, so nothing breaks. Confirmed for
`deep-link-load-gap`, `deep-link-settle-then-register`, `pane-isolation`,
`history-sink`, `sticky-resolve-guard`, and `conversations/pane-restore`'s
`pane-restore-isolation`.
`primitives/error-boundary/web/__tests__/crash-fallback-truncate.test.tsx:18` only
asserts on the literal `usePaneStore()` error string as a truncation fixture — it is
**not** a pane mount, but if B5 reworders that string, check it.

---

## Ordering

**Land Part A first, then Part B.** Part A's correctness does not depend on Part B:
inside `pagesTreePane` the Miller renderer provides `PaneMatchContext` per column, so
`PagesSidebar`'s `selectedId` highlight and its `useOpenPane` push both work
immediately. Part A is small, self-contained and independently shippable.

Part B touches a load-bearing primitive and flips five previously-dead code paths on;
it deserves its own review and its own verification pass. Sub-order within B:
**B1–B3 (the hoist) → verify → B5 (the throw)**.

---

## Files

**Part A — create**
- `plugins/apps/plugins/agent-manager/plugins/pages-nav/web/index.ts`
- `plugins/apps/plugins/agent-manager/plugins/pages-nav/package.json`
- `plugins/apps/plugins/agent-manager/plugins/pages-nav/CLAUDE.md`
- `plugins/apps/plugins/agent-manager/plugins/pages-nav/web/components/pages-tree-button.tsx`

**Part A — modify**
- `plugins/apps/plugins/pages/plugins/page-tree/core/routes.ts` (+ `core/index.ts` export)
- `plugins/apps/plugins/pages/plugins/page-tree/web/panes.tsx`
- `plugins/apps/plugins/pages/plugins/page-tree/web/index.ts`
- `config/conversations/conversation-view/action-bar/conversation.action-bar.jsonc`
  (place the new entry in the slot order, drop the seeded `// @review` marker)

**Part B — modify**
- `plugins/primitives/plugins/pane/web/pane.ts` (`PaneSurfaceProvider` + `SurfaceMatchProvider`; B5: context sentinel + the six accessors)
- `plugins/layouts/plugins/miller/web/components/miller-columns.tsx`
- `plugins/layouts/plugins/full-pane/web/components/full-pane.tsx`
- `plugins/layouts/plugins/host/web/components/pane-layout-host.tsx`
- `plugins/layouts/plugins/miller/web/components/pane-overlay-host.tsx` *(optional cleanup)*
- `plugins/layouts/plugins/{miller,full-pane,host}/CLAUDE.md` (hand-written prose)
- `plugins/primitives/plugins/pane/CLAUDE.md` ("Query the route from outside a pane" section)

**Autogenerated by `./equin build` — do not hand-edit**
- `plugins/framework/plugins/web-sdk/core/web.generated.ts`
- `plugins/framework/plugins/web-sdk/core/web-tiers.generated.ts`
- `docs/plugins-compact.md`, `docs/plugins-details.md`, per-plugin `CLAUDE.md` autogen blocks

## Primitives reused (do not re-derive)

| Need | Use | Path |
|---|---|---|
| Conversation toolbar slot | `Conversation.ActionBar` | `plugins/conversations/plugins/conversation-view/plugins/action-bar/web` |
| Pane definition (new form) | `defineRoute` + `Pane.define({ route })` | `plugins/primitives/plugins/pane/core`, `…/pane/web` |
| Pane header + the one body scroll | `PaneChrome` | `plugins/primitives/plugins/pane/web` |
| The page-tree slot | `Pages.Sidebar` | `plugins/apps/plugins/pages/plugins/shell/web` |
| Toolbar toggle button | `pane.useToggle({})` | `pane.ts:1458`; copy `plugins/code-explorer/web/components/conv-tree-button.tsx` |
| Deps-gated render-phase write | `useRenderSync` | `plugins/primitives/plugins/pane/web/use-render-sync.ts` |

---

## Verification

### 1. `./equin build` (regenerates, then checks)

Then `./equin check`. Expected to be exercised:

| Check | Why it fires / what to confirm |
|---|---|
| `pane:segments-unique` | new `"pages-tree"` segment must not collide |
| `plugins-registry-in-sync` | `web.generated.ts` must pick up `pages-nav` |
| `eager-tier-in-sync` | **confirm** `apps/plugins/agent-manager/plugins/pages-nav` is in `DEFERRED_PLUGIN_PATHS` and adds no "pinned EAGER" line |
| `plugins-doc-in-sync` | new plugin + changed exports/contributions in the docs |
| `plugin-boundaries` | barrel-only cross-plugin imports; no cross-plugin re-export of `Pages`/`pagesTreePane`; no cycle |
| `type-check` (tsc + type-aware ESLint) | the renderers' dropped `match` prop; B5's `PaneMatch \| null \| undefined` widening at every consumer |
| `eslint` | `no-adhoc-row-list` (the pane body renders a slot, not a `.map()` of rows — should pass), `no-adhoc-pane-title`, layout rules |
| `config-origins-in-sync` / `config:overrides-authored` | `Conversation.ActionBar` is reorderable and `config/conversations/conversation-view/action-bar/conversation.action-bar.jsonc` + its `.origin.jsonc` already exist ⇒ a new contribution moves the origin hash and re-marks the override with `// @review`. **Expect this**: place the new "pages" entry in the slot order and delete the marker line. |

### 2. Tests

```bash
bun run test:dom plugins/primitives/plugins/pane
bun run test:dom plugins/conversations/plugins/pane-restore
bun run test:dom plugins/primitives/plugins/error-boundary
bun test plugins/framework/plugins/tooling/plugins/codegen/core   # isAppContent / computeEagerTier units
```

### 3. End-to-end (after `./equin build`)

Use the click-and-verify harness, not blind snapshots
(`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts` prints the
matched button's state and writes `-before.png` / `-after.png`):

**A — the new pane**
```bash
bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
  --url http://<worktree>.localhost:9000/agents/c/<convId> --click "Pages" --out /tmp/pages-tree
```
Expect: a second Miller column titled "Pages" appears **to the right of the
conversation** (the conversation stays visible), containing the Search row, the
page tree DataView (with its view switcher) and the Trash row. URL becomes
`/agents/c/<convId>/pages-tree`. Then click a page row → a third column appears to
its right with the page body; the tab title becomes the page title (`titleOwner`).
Click the toolbar button again → the tree column closes (`useToggle`). Reload the
three-column deep link → all columns restore (the deferred tier loads;
`DeferredRouteFallback` may flash first).

**B — the restored highlights**, one per affected app:
```bash
# Pages app: open a page, then confirm its sidebar row is highlighted
bun …/screenshot.ts --url "http://<worktree>.localhost:9000/pages/page/<pageId>" --out /tmp/pages-hl
```
Check visually in `-before.png` that the sidebar row for `<pageId>` is active. Repeat
for Mail (`/mail/v/inbox` → "Inbox" active in the mailbox nav), Workflows
(`/workflows/…` → active definition), and the agent-manager conversations sidebar
(`/agents/c/<id>` → active conversation row).

**B — no regressions in the layout renderers:** load a Miller app (`/agents`), a
full-pane app (`/sonata`, `/website`), the overlay-host app (`/home`, then open the
theme customizer from the action bar — the overlay must still appear), and confirm
a bare app root still renders its index pane (`/agents` → Welcome, `/pages` → the
Pages landing).

**B — the load-bearing negative test:** the global action bar (theme customizer,
Improve, build button) must still open panes. After B5, a match read from global
chrome throws loudly — click through every action-bar item and watch the console
and Debug → Reports for a `PluginErrorBoundary` crash.

### 4. Reports

After exercising the app, check Debug → Reports for new frontend crash reports —
that is where a B5 throw from an unexpected out-of-surface caller will surface.

---

## Risks and unverified items

1. **🟠 Reorder config re-seed.** `Conversation.ActionBar` is a reorderable render
   slot and `config/conversations/conversation-view/action-bar/conversation.action-bar.jsonc`
   + `.origin.jsonc` already exist, so adding a contribution moves the origin hash
   and re-marks the override with `// @review`. `config:overrides-authored` is
   `alwaysRun` and fails `--skip-checks` builds. Expect to hand-place the new entry
   and delete the marker.
2. **🟠 Newly-live code paths.** The five components in §B4 have never executed their
   "selected" branch. Any `useRevealOnActive` / scroll-into-view inside them fires for
   the first time. Verified for `PagesSidebar` and `DeletePageAction`; **not**
   individually audited for `MailboxNav`, `WorkflowsSidebar` or `ConversationList`.
3. **🟠 Surfaces that mount no layout renderer** (browser, sonata, website, home) now
   get `setBasePath` + a registry sync on their own store where previously they got
   neither. Believed a fix; not empirically verified.
4. **🟡 B5's throw** could trip an active-data chip rendered inside global chrome.
   Mitigated by landing it as a separate, revertible commit.
5. **🟡 `PaneOverlayHost` cleanup** (dropping its redundant `setBasePath` /
   `useSyncPaneRegistry`) is recommended but the only consumer is the Home app;
   verify the Home overlay before and after.
6. **🟡 Not verified:** whether any *non-web* surface (desktop/release build,
   `apps-core/surface/floating` multi-window) mounts a second `PaneSurfaceProvider`
   in a way that would nest `SurfaceMatchProvider`. Nesting is harmless (inner wins,
   which is correct), but worth a look during implementation.
