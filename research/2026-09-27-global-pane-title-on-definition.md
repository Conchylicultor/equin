# Pane title on the definition — one header row, one way in

## Context

Agents keep putting a *second slot* into a pane's header row instead of using a
`spacer` in the one header slot's order file. Three cases so far:

| Case | How it got in |
|---|---|
| Pages `PageDetail.HeaderActions` (June 2026) | passed through `<PaneChrome extra={…}>` |
| `PageDetail.TitleActions` (this worktree, reverted) | rendered inside `<PaneChrome title={<PageTitleTrail/>}>` |
| Conversation `Conversation.Header` (live today) | `<PaneChrome title={<HeaderView/>}>`, HeaderView renders the whole chip slot |

The lint `spacer/no-split-slot-row` cannot catch these: it compares `<X.Render>`
elements inside one JSX tree, and every case crosses a component boundary.

The root cause is `PaneChrome`'s node props. The header already *is* one slot
(`pane.Actions`); the title is an item of it (`primitives.pane:title`, auto-minted
per header slot in `plugins/primitives/plugins/pane/web/header-slot.ts:89`). But
that item has no content of its own — it paints whatever the body passes as
`<PaneChrome title={…}>` at render time (via `PaneTitleContext`), and that prop
accepts any `ReactNode`, a slot included. `extra` was the same kind of door; it is
already removed in this worktree (Pages was its only caller).

**Outcome:** the title is declared on `Pane.define`, `PaneChrome` accepts no header
content at all, and the only way into the header row is an item of the pane's one
header slot, placed by its order file. A runtime guard covers the one remaining
door (a rich title component rendering a slot).

## API

Before:
```tsx
Pane.define({ …, chrome: { title: (p) => p.pageId }, useTitle: usePageTitle });
<PaneChrome pane={pageDetailPane} title={<PageTitleTrail pageId={pageId} />}>
```

After:
```tsx
Pane.define({
  …,
  title: {
    text: usePageTitle,         // string: tab title, document title, header title
    fallback: (p) => p.pageId,  // optional: while `text` yields undefined (today's chrome.title)
    component: PageTitleTrail,  // optional: rich header title (breadcrumb); reads pane.useParams()
  },
});
Pane.define({ …, title: "Settings" });   // shorthand for { text: "Settings" }
<PaneChrome pane={pageDetailPane}>…</PaneChrome>   // no title prop
```

- `title?: string | PaneTitleSpec<Params>`;
  `PaneTitleSpec = { text?: string | TitleHook; fallback?: string | ((params) => string); component?: ComponentType }`.
- `TitleHook` keeps today's `useTitle` contract exactly: `(params, hint, options) => string | undefined`,
  runs **outside** the app's providers (tab-surface level, also for background tabs —
  `plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx:103-184`), so
  it may read only params (full, ancestors included), hint, options and global hooks.
- `component` is mounted **inside** the pane (header cell under `PaneChrome`), so it
  may use `pane.useParams()`, app context, and be interactive (Sonata's editable title).
- Removed: `chrome.title`, `useTitle`, `<PaneChrome title>`. Kept unchanged:
  `titleOwner` (which pane owns the tab title — a different question), `titleOnly`.
- Resolution, one function (`usePaneTitle`, `plugins/primitives/plugins/pane/web/pane.ts:2549`),
  used by both the tab reporter and the header: `text` → else `fallback` → else nothing.
  The header item paints `component` if declared, else that string.

## Implementation

### 1. Pane primitive — `plugins/primitives/plugins/pane/`
- `web/pane.ts`: add `title` to `Pane.define` args; normalize to
  `{ useText, fallback, component }` on `PaneInternal` (replacing `chrome.title` /
  `useTitle`, `pane.ts:175`, `:270-286`, `:2328`, `:2415`). A string `text` normalizes
  to a constant hook. Update `usePaneTitle` to read the new fields.
- `web/components/pane-chrome.tsx`: delete the `title` prop and `chromeTitle()`
  (`:239-246`). Publish on `PaneTitleContext` either the pane's `component` or the
  string from `usePaneTitle(pane, match.fullParams, hint, options)`. `PaneChrome` is
  always rendered for one pane, so the hook order is stable.
- Borrowed header slots (`Pane.define({ actions })`, website panes) keep working:
  one title item per slot, content from the `PaneChrome` of whichever pane renders it.
- `headerSpill` and `PaneTitleValue.spill`: delete if the conversation was the only
  user (inventory says yes — verify with rg). Update `collapsible-wrap/CLAUDE.md`,
  which documents the spill path.
- **Runtime guard.** `PaneChrome` wraps the yield cell's content in a pane-owned
  `InsidePaneTitleContext`. The pane plugin registers one slot item middleware
  (`registerSlotItemMiddleware`, `plugins/primitives/plugins/slot-render/web/internal/registry.ts:11`)
  that throws when a contribution renders while that context is set:
  *"A render slot mounted inside the pane title. The header is one slot: contribute
  to `<pane>.Actions` and place it with a spacer in the order file."*
  The dependency direction is correct: pane already imports slot-render, never the reverse.
  The throw lands in the item's error boundary, so it is loud and contained.
- `CLAUDE.md`: rewrite the title sections (`:307`, `:311-327`, `:411-433`) around
  `title: {…}`; state the "no side door into the row" rule.
- Tests: update `web/__tests__/pane-header.test.tsx` (title item, `titleOnly`,
  yield growth); add a guard test: a slot rendered inside `title.component` throws.
  Keep `e2e/header-reorder.ts` passing unchanged.
- Lints that read the old spelling:
  - `pane/lint/no-adhoc-pane-title.ts` bans `<Text variant>` inside `<PaneChrome title={<…>}>`.
    Retarget it to a `title: { component: X }` whose `X` is defined in the same file.
  - The `useTitle:` carve-out in `live-state/lint/no-pending-data-collapse.ts:435-453`
    (and its test fixtures) moves to `title: { text: … }`.

### 2. Call-site migration (~114 `<PaneChrome>` sites; tsc flags every one)
Most sites follow one pattern: move the value from the body's `PaneChrome` onto the
`Pane.define` in the same plugin's `panes.tsx`.

| Kind | Count | Move |
|---|---|---|
| String literal | 77 | `title: "Reports"` |
| String from own params / global resource | ~15 | `title: { text: useXTitle, fallback: "X" }`. The hook reads the same resource by param. Examples: `debug/plugins/reports/web/components/report-detail.tsx:56`, `code-explorer/plugins/commit-detail/.../panes.tsx:32`, `deploy/servers/panes.tsx:100` |
| Duplicates of an existing `useTitle` | 3 | delete the prop, rename `useTitle` → `title.text` (task-detail, events runs, conversation) |
| Several loading/missing/error `PaneChrome`s with different titles | ~9 panes | fold into one `text` (found) + `fallback` (the generic noun). The servers pane's "Add Server" state becomes a branch on its param |
| Rich node | 7 | `title.component`: `PageTitleTrail` (page + block panes; the block pane's crumb reads its own params), `FilepathBreadcrumb` (file-peek, keeps `titleOnly`), `SongTitle` (Sonata, editable, app context OK), `PrototypeTitle`, attempts "Attempts + badge", conversation (below) |
| No title today | 6 | block pane states and website get it from the definition. **deployments / compositions** show no header title today but have `useTitle`: hide `primitives.pane:title` in their order files so they look the same |

Hard cases to check during migration:
- `mail/.../mail-message-reader.tsx:87` takes its subject from the opener's hint plus
  hydration. Make `text` use `hint.pick("subject")`, the same way `useTitle` already
  receives the hint; drop the hydration refinement from the header.
- `workflow-node-pane.tsx:52` reads `convId` from the ancestor pane. `text` receives
  `fullParams` (ancestors included, `tab-surface.tsx:115`), so it can read it there.
  Otherwise use `component`.

Run the migration as batches by plugin area (Sonnet subagents with the pattern
table above), then one `./equin build` / `check`.

### 3. Conversation header → the pane's own slot
- `conversationPane` (`plugins/conversations/plugins/conversation-view/web/panes.tsx`):
  `title: { text: useConversationTitle, component: ConversationTitle }`
  (`ConversationTitle` is today's `conversation-view:title` item, which already reads
  `conversationPane.useParams()`).
- Move the other six `Conversation.Header(...)` contributions to `conversationPane.Actions(...)`,
  keeping each id so the `<pluginId>:<id>` order keys survive: agents `agent-avatar`,
  conversation-preprompt `preprompt`, conversation-progress `progress`, model `model`,
  status `status`, allow-monitor `allow-monitor`.
- Delete the `Conversation.Header` slot, `HeaderView`, and `title` / `titleOnly` /
  `headerSpill` on this `PaneChrome` (`conversation-view.tsx:71`). The header slot has
  no other contributors, and the icon toolbar below is the separate `ActionBarView`.
- Order file: move `config/conversations/conversation-view/header/header.jsonc` to
  `config/conversations/conversation-view/conversation.actions.jsonc`:
  `agent-avatar, primitives.pane:title, {spacer "title-end"}, preprompt, allow-monitor, model, status, progress`.
- Behaviour change (to confirm): chips no longer wrap onto extra rows behind a chevron.
  The row stays one line, each chip shrinks to its declared smaller form, and what
  still doesn't fit goes to the `⋯` panel. The title cuts off with "…" (min 8em).

### 4. Keep the lint honest
Extend the `spacer/no-split-slot-row` message and doc comment. Name the pane case
explicitly ("a pane header is ONE slot, `<pane>.Actions`; its title comes from
`Pane.define({ title })`"), so an agent that hits a same-tree split learns the
right shape.

## Verification
- `./equin check` (type-check flags every missed call site; plugin docs and
  config checks), then `./equin test plugins/primitives/plugins/pane`
  plus the live-state lint tests.
- `./equin run plugins/primitives/plugins/pane/e2e/header-reorder.ts`: title still
  one sortable item, across ordinary, rich (Sonata) and shared (website) headers.
- Screenshots (`e2e-harness/e2e/screenshot.ts`) of: a string-title pane (Reports), a
  loaded-title pane loading and ready (task detail), Pages (copy-id beside the
  breadcrumb, actions right), a block pane, the conversation header at 1280 and at a
  narrow width (⋯ overflow), a file-peek pane, the Sonata player (title still editable),
  and deployments (no header title, as before).
- Tab titles unchanged: open several tabs incl. a background one and compare labels.
- Guard: a scratch contribution rendering a slot inside a `title.component` shows
  the thrown message in its error boundary. Remove it afterwards.
