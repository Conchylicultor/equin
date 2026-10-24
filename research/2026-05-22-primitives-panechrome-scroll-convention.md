# PaneChrome Scroll Convention

## Context

PaneChrome wraps pane children in `<div className="min-h-0 flex-1 overflow-y-auto">`. This was recently changed from `overflow-hidden` (commit bc21a940) to fix panes that were silently clipped. But now ~50 panes handle scrolling in 4 inconsistent ways:

- **14 panes** redundantly add `overflow-auto` / `overflow-y-auto` inside PaneChrome (double scroll container)
- **10 panes** put `overflow-hidden` on their root to suppress PaneChrome's scroll (implicit opt-out)
- **9 panes** correctly rely on PaneChrome (no overflow on root)
- **8+ panes** have complex flex layouts with internal scroll containers

There's also a fragile DOM query in `MessageToc` that finds the scroll container via `.closest(".overflow-auto")`.

## Convention

**PaneChrome owns the scroll. No new API needed.**

PaneChrome's `overflow-y-auto` content wrapper is the universal scroll container. Pane bodies should never set `overflow-*` on their root div. No `scroll` prop — the existing behavior is sufficient for all cases:

- **Simple content** — PaneChrome scrolls it. Don't add overflow.
- **Header + scrollable body** — Root is `flex h-full flex-col`. The sub-header is fixed, the body area is `flex-1 min-h-0 overflow-auto`. Because the root is `h-full`, it exactly fills PaneChrome's wrapper — PaneChrome's scroller is naturally inert (nothing to scroll). The inner scroller handles the body.
- **Custom viewport** (terminal, canvas) — Root is `h-full`. Viewport component manages its own sizing internally. PaneChrome's scroller is inert. An `overflow-hidden` on the root is acceptable as a defensive measure for these few panes.

Key insight: panes with `h-full` on their root make PaneChrome's `overflow-y-auto` inert — the content fits the wrapper exactly, so the outer scroller never activates. This means complex panes don't need PaneChrome to opt out; they just size themselves correctly.

## Implementation

### Step 1: Fix MessageToc fragile DOM query

**`jsonl-viewer/web/components/jsonl-pane.tsx`** — Add `data-pane-scroll` attribute to the scroll div:
```tsx
<div ref={sticky.scrollRef} data-pane-scroll className={`h-full overflow-auto ...`}>
```

**`message-toc/web/components/message-toc.tsx`** — Replace `.closest(".overflow-auto")` (line 94):
```tsx
// Before
const container = document.querySelector("[data-event-index]")?.closest(".overflow-auto");
// After
const container = document.querySelector("[data-pane-scroll]");
```

### Step 2: Clean up Category A — remove redundant scroll containers (14 panes)

These panes add `h-full overflow-auto` on their root inside PaneChrome, creating a double scroll container. The inner one is inert (or the outer one is, depending on sizing) — either way the redundancy should go. Remove `h-full` and `overflow-*` from the root, keep layout/padding classes. PaneChrome handles the scroll.

| Component file | Current root class | After |
|---|---|---|
| `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/` | `flex flex-col gap-4 overflow-y-auto h-full` | `flex flex-col gap-4` |
| `plugins/backup/web/components/backup-panel.tsx` | `h-full overflow-y-auto` | remove wrapper or keep as plain div |
| `plugins/stats/web/components/stats-panel.tsx` | `h-full overflow-auto p-6` | `p-6` |
| `plugins/auth/web/components/accounts-pane.tsx` | `flex h-full flex-col gap-4 overflow-y-auto p-6` | `flex flex-col gap-4 p-6` |
| `plugins/conversations/plugins/summary/web/components/summary-pane.tsx` | `flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 text-sm` | `flex flex-col gap-3 p-3 text-sm` |
| `plugins/.../tool-call/plugins/agent/web/components/agent-report-pane.tsx` | `h-full overflow-auto p-4` | `p-4` |
| `plugins/tasks/plugins/task-detail/web/panes.tsx` (TaskDetailBody) | `h-full overflow-auto` | remove wrapper |
| `plugins/build/web/panes.tsx` (BuildDetailBody) | `h-full overflow-auto` | remove wrapper |
| `plugins/agents/web/panes.tsx` (AgentDetailBody) | `h-full overflow-auto` | remove wrapper |
| `plugins/agents/web/panes.tsx` (SystemAgentDetailBody) | `h-full overflow-auto` | remove wrapper |
| `plugins/agents/web/panes.tsx` (AgentSideBody) | `h-full min-h-0 overflow-auto` | remove wrapper |
| `plugins/.../file-pane/web/file-peek-pane.tsx` | `h-full min-h-0 overflow-auto` | remove wrapper |
| `plugins/apps/plugins/deploy/plugins/servers/web/` (ServerDetailContent) | `h-full overflow-auto` | remove wrapper |

### Step 3: Clean up Category B+D — remove redundant root `overflow-hidden` (10 panes)

These panes put `overflow-hidden` on their root to suppress PaneChrome's scroll, then manage their own scroll internally. Since their root is `h-full`, PaneChrome's scroll is already inert — the `overflow-hidden` is redundant. Remove it.

| Component file | Current root class | After |
|---|---|---|
| `debug/plugins/memory/web/components/memory-panel.tsx` | `flex h-full overflow-hidden` | `flex h-full` |
| `debug/plugins/broadcasts/web/components/broadcasts-panel.tsx` | `flex h-full flex-col overflow-hidden` | `flex h-full flex-col` |
| `debug/plugins/claude-cli-calls/web/components/calls-view.tsx` | `flex h-full flex-col overflow-hidden` | `flex h-full flex-col` |
| `debug/plugins/profiling/web/components/gantt-view.tsx` | `flex h-full flex-col overflow-hidden` | `flex h-full flex-col` |
| `debug/plugins/queue/web/components/queue-view.tsx` | `flex h-full flex-col overflow-hidden` | `flex h-full flex-col` |
| `commits-graph/web/components/commits-graph-body.tsx` | `flex h-full flex-col overflow-hidden text-sm` | `flex h-full flex-col text-sm` |

**Viewport panes — keep `overflow-hidden` (defensive):**

These 4 panes use custom viewports (terminal, virtual tree, canvas) where content sizing is non-standard. Keep `overflow-hidden` as a defensive measure — it's the pane's own concern, not a PaneChrome override:

- `terminal-pane-body.tsx` — `h-full min-h-0 overflow-hidden` (terminal viewport)
- `code-explorer/` GlobalFileTreeBody — `h-full min-h-0 overflow-hidden` (virtual tree)
- `code-explorer/` ConvFileTreeBody — `h-full min-h-0 overflow-hidden` (virtual tree)
- `screenshot/` ScreenshotView — `flex h-full min-h-0 w-full overflow-hidden` (canvas)

### Step 4: SettingsPanel — keep as-is

SettingsPanel has `<div ref={scrollRef} className="h-full overflow-y-auto">` because its `IntersectionObserver` needs an explicit `root` element for section highlighting. With `h-full`, PaneChrome's scroll is inert and SettingsPanel's div is the real scroll container. This is correct — no changes needed.

### Step 5: Document in CLAUDE.md

**File:** `plugins/primitives/plugins/pane/CLAUDE.md`

Add under the Chrome section:

```markdown
### Scroll responsibility

PaneChrome's content wrapper is `overflow-y-auto` — it scrolls by
default. Pane bodies should not add `overflow-*` on their root div.

- **Simple content** → do nothing. PaneChrome scrolls.
- **Header + scrollable body** → root is `flex h-full flex-col`.
  Sub-header is fixed, body is `flex-1 min-h-0 overflow-auto`.
  PaneChrome's scroll is naturally inert (`h-full` fills it exactly).
- **Custom viewport** (terminal, canvas) → root is `h-full`.
  `overflow-hidden` on root is acceptable as a defensive measure.

Exception: if the pane needs a ref to the scroll container (e.g.
IntersectionObserver root), it may keep its own `overflow-y-auto`
div with `h-full` — PaneChrome's scroll stays inert.
```

## Left alone

- **`chrome: false` panes** (agentsRootPane, tasksRootPane, serversRootPane, conversationPane, eventsTestPane) — bypass PaneChrome entirely, own their layout.
- **Viewport panes** (terminal, file tree, screenshot) — keep `overflow-hidden` on root as defensive measure.
- **SettingsPanel** — keeps own `overflow-y-auto` for IntersectionObserver root ref.
- **`useStickyScroll`** — fully self-contained; creates own scroll container via ref.
- **`scrollIntoView` calls** (RawView, useTreeRow) — traverse DOM upward, work with any ancestor scroll container.
- **`useCursorPagination`** — IntersectionObserver with default viewport root, not pane-dependent.

## Verification

1. `./equin build` — compiles cleanly
2. Spot-check in browser:
   - **Category A panes** (task detail, agent detail, stats, backup, accounts, etc.): content scrolls, no double scrollbar
   - **Category B+D panes** (memory, broadcasts, profiling, logs, queue): header stays pinned, body scrolls
   - **Viewport panes** (terminal, file tree, screenshot): viewport fills column, no extra scrollbar
3. MessageToc "jump to bottom" button in JSONL viewer works
4. SettingsPanel left-nav section highlighting tracks scroll position
5. No double scrollbars anywhere
