# PaneChrome unification — make explicit wrapping the convention

## Context

`<PaneChrome>` was added alongside the unified pane primitive (see
[`2026-04-23-global-unified-pane-manager-v3.md`](./2026-04-23-global-unified-pane-manager-v3.md))
as the standard pane header — back/forward, optional title, an `Actions`
contribution slot, and an optional expand button. It exists at
`plugins/pane/web/components/pane-chrome.tsx:19` and is re-exported from
`plugins/pane/web/index.ts:14-18`.

**Today nobody uses it.** A repo-wide search finds zero `<PaneChrome>` JSX
usages outside the file that defines it. The `chrome` config on
`Pane.define` is normalized but never read by any renderer; the per-pane
`Actions` slot is created for every pane but no plugin contributes to it.
Two panes set `chrome: { history, expand }` (`taskConversationPane` is the
only one I found via grep) and get nothing from it because the chrome is
never rendered.

The result is visual drift: every pane invents its own header (or has
none), and there is no place for cross-cutting actions (expand, "open in
new tab", refresh, etc.) to land. Goal: make `<PaneChrome>` the standard
wrapper so every pane gets a consistent header without each plugin
reinventing it.

Per the picked option, integration is **explicit**: each pane component
wraps its own body with `<PaneChrome>`, and panes that don't want chrome
declare `chrome: false`. No router-level auto-injection.

## Approach

### Rule

A pane component renders one of two shapes:

```tsx
// Default — opt in to chrome
function MyPaneBody() {
  return (
    <PaneChrome pane={myPane} title="…">
      {/* body, may include <Outlet/> and <pane.Provider> */}
    </PaneChrome>
  );
}

// Opt out — declare in Pane.define and render raw
export const myPane = Pane.define({ …, chrome: false, component: MyBody });
function MyBody() { return <RawContent />; }
```

PaneChrome already short-circuits to `<>{children}</>` when
`chrome.enabled` is false (`pane-chrome.tsx:21`), so the wrapper itself is
safe to leave in place even on opt-out panes — but for clarity, opt-out
panes should also drop the wrapper.

### Per-pane categorization

I went through all 16 pane definitions. Three buckets:

**A. Chrome ON (wrap with `<PaneChrome>`)** — content panes that benefit
from a header, history, and an actions slot:

- `welcomePane` — title "Welcome".
- `settingsPane` — title "Settings".
- `statsPane` — title "Stats".
- `dbBackupPane`, `worktreeCleanupPane`, `logsPane`, `logChannelPane` —
  Debug panes; titled.
- `taskDetailPane` — title from loaded task.
- `agentDetailPane` — title from loaded agent.
- `taskConversationPane`, `agentConversationPane` — already opt into
  `chrome` config; just wrap.
- `convFileTreePane`, `globalFileTreePane` — file tree; title "Files".
- `convJsonlPane` — title "JSONL".
- `convReviewPane` — title "Review".
- `screenshotPane` — title "Screenshot".

**B. Chrome OFF (`chrome: false`)** — root layout containers whose body
*is* a split / sidebar layout. Adding a header here would push the split
down and create double-chrome with their leaf children.

- `tasksRootPane`, `agentsRootPane` — `<ResizablePanelGroup>` is the body.
  The right-hand `<Outlet/>` hosts a child pane that itself wraps with
  PaneChrome. Adding chrome here would stack a "Tasks" header above the
  whole split with no parent to navigate back to.
- `conversationPane` — `<ConversationView>` already renders its own
  `Conversation.Toolbar`, `Conversation.Title`, and `Conversation.PromptBar`
  slots. Opting in would double the header. Migrating
  `ConversationView` onto PaneChrome's `Actions` slot is a bigger refactor
  out of scope here — leave `chrome: false` and revisit separately.

**C. Inline / config-driven** — `taskConversationPane` and
`agentConversationPane` already declare `chrome.expand` so they can pop
out of the split into the full conversation pane. Once we wrap them with
`<PaneChrome>`, the existing config starts working with no further
changes.

### One small API change

PaneChrome currently takes `title` as a prop, but `Pane.define` already
accepts `chrome.title` as `string | (params) => string`. To avoid every
pane reading params and computing the same string, have PaneChrome
fall back to `chrome.title` when no `title` prop is passed:

```tsx
// pane-chrome.tsx — inside PaneChrome, before the header render:
const resolvedTitle =
  title ??
  (typeof chrome.title === "function"
    ? chrome.title(currentEntry.fullParams)
    : chrome.title);
```

Look up the current entry from `useCurrentPane()` /
`PaneMatchContext` (already exported). The `title` prop stays as the
override path for cases where the title needs loaded data (e.g.,
`taskDetailPane` showing the task name from `useData()`).

### Convention enforcement

There is no clean way to enforce "every pane wraps with PaneChrome" at
the type level — `component: ComponentType` is opaque. Two soft options:

1. Document the rule in `plugins/pane/web/CLAUDE.md` (the "Chrome"
   section already mentions PaneChrome but presents it as optional;
   reword as the default).
2. Add a dev-only runtime check in `PaneLevel` that walks the rendered
   tree and warns if neither `<PaneChrome>` nor `chrome: false` is
   present. Possible via a `ref` + DOM data attribute set by
   `PaneChrome`. Marginal value, defer.

Going with (1) only.

## Caveats / known gaps

These don't block the unification but should be called out:

- **History buttons are global**, not pane-scoped. `pane.back()` /
  `forward()` call `window.history.back()` (`pane.ts:354,358`). The
  pane's own ‹ › buttons therefore navigate any history entry, including
  ones from before the pane was opened. The CLAUDE.md flags this under
  "Not yet implemented".
- **Actions slot has no contributors yet.** PaneChrome will render an
  empty actions area for every pane until plugins start contributing. The
  slot is wired (`pane.ts:283`) but no `pane.Actions({ component })`
  calls exist anywhere. First likely contributors: a "VSCode" /
  "open-app" / "refresh" trio for content panes.
- **Container panes are special-cased.** The `chrome: false` opt-outs
  for `tasksRoot`, `agentsRoot`, `conversation` mean unification is not
  100% — three panes won't have the standard header. This is intrinsic
  to the layouts those panes own; chrome over a `ResizablePanelGroup`
  would just push the split down.
- **Title from `useData()`** stays per-pane: `taskDetailPane` and
  `agentDetailPane` need the loaded task/agent name. The `chrome.title`
  config only sees URL params, so these panes pass `title` as a prop.
  Acceptable; same pattern in both places.
- **Provider timing**: action contributors that want to call
  `pane.useData()` only work if `<PaneChrome>` is rendered *inside* the
  `pane.Provider`. The pattern below makes that the default — wrap
  `<PaneChrome>` after the data load gate, like `taskDetailPane` already
  does for its body content.

## Files to modify

Pane plugin (the API tweak):

- `plugins/pane/web/components/pane-chrome.tsx` — fall back to
  `chrome.title` when `title` prop is omitted; resolve via
  `useCurrentPane()`.
- `plugins/pane/web/CLAUDE.md` — rewrite the "Chrome" section: state
  that `<PaneChrome>` is the default convention, `chrome: false` is the
  opt-out, list the categorization rule (content pane → wrap; layout
  container → opt out).

Pane definition files (one wrap per pane in bucket A, one `chrome: false`
in bucket B). All listed with current line of the `Pane.define` call:

- `plugins/welcome/web/panes.ts` — wrap.
- `plugins/config/web/panes.ts` — wrap.
- `plugins/stats/web/panes.ts` — wrap.
- `plugins/debug/plugins/db-backup/web/panes.ts` — wrap.
- `plugins/debug/plugins/worktree-cleanup/web/panes.ts` — wrap.
- `plugins/debug/plugins/logs/web/panes.tsx` — wrap (both panes).
- `plugins/screenshot/web/panes.tsx` — wrap.
- `plugins/code-explorer/web/panes.tsx` — wrap (both panes).
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/panes.tsx` — wrap.
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/panes.tsx` — wrap.
- `plugins/tasks/web/panes.tsx`:
  - `tasksRootPane` → add `chrome: false`.
  - `taskDetailPane` → wrap inside `TaskDetailBody`, after the data load.
  - `taskConversationPane` → wrap (already declares `chrome.expand`).
- `plugins/agents/web/panes.tsx` — same three-way split as tasks.
- `plugins/conversations/plugins/conversation-view/web/panes.tsx`:
  - `conversationPane` → add `chrome: false` (ConversationView owns its
    own header).

## Verification

1. `./equin build` succeeds (worktree deploys at
   `http://<worktree>.localhost:9000`).
2. Click through every sidebar entry and confirm:
   - Bucket A panes show the chrome header with title; back/forward
     buttons render; no actions area visible (slot empty).
   - Bucket B panes (Tasks, Agents, conversation) look identical to
     today — no extra header.
3. For `taskConversationPane` / `agentConversationPane` (the panes inside
   the right half of the Tasks/Agents split): the chrome header shows an
   expand button (`MdOpenInFull`); clicking it navigates to
   `/c/<convId>` (full conversation view).
4. Drive it with `bun e2e/screenshot.mjs` for a couple of the trickier
   panes (e.g., open `/tasks/<id>/c/<convId>` and screenshot to confirm
   chrome on the right pane only).
5. No regression in conversation view (Bucket B opt-out): toolbar slots
   still render normally.

## Out of scope

- Migrating `ConversationView`'s bespoke toolbar onto `pane.Actions` —
  separate, larger refactor.
- Pane-scoped history stack (replacing `window.history.back/forward`).
- Auto-wrapping at `PaneLevel` / lint rule to enforce the convention.
- Adding any actual `Actions` contributors. The slot starts empty; first
  use case opens that conversation.
