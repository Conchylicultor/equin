# Button `loading` affordance sweep

## Context

Many buttons that trigger slow async actions give no visual feedback while the
action is in flight, so the button looks unresponsive and users click again.

The `Button` primitive
(`plugins/primitives/plugins/ui-kit/web/components/ui/button.tsx`) now supports a
`loading` prop and auto-derives pending from a promise-returning `onClick`:

- `loading={true}` → shows a spinning `MdRefresh` and disables the button
  (rendered `disabled = disabled || loading || autoPending`).
- If `onClick` **returns a thenable**, the button auto-enters the pending state
  until it settles (`handleClick` at button.tsx:92-100). A `void`-returning
  handler never triggers this.
- For text buttons the spinner is **prepended** to the label; for icon-shaped
  buttons (`size` starts with `"icon"`) the spinner **replaces** the glyph.
- `IconButton` (`plugins/primitives/plugins/icon-button/web/components/icon-button.tsx`)
  extends `Button`'s props and forwards `loading`/`onClick` transparently — no
  separate handling.

Most existing call sites haven't adopted it: a large group tracks an in-flight
flag (`isPending`/`saving`/`building`/`busy`/…) and passes it only to
`disabled` (greys out, no spinner — **Category A**); a smaller group is
fire-and-forget (`onClick={() => void mutate()}`) and returns void, so it gets
no auto-pending and no feedback at all (**Category B**).

The goal: sweep action buttons onto the loading affordance so any slow click is
self-indicating and double-click-proof.

## Decisions (confirmed with user)

1. **Scope: Category A + B.** Migrate `Button`/`IconButton` sites. The four
   exit-menu `DropdownMenuItem` actions and the 2 native `<button>` sites are
   **out of scope** (different primitive) — filed as task
   `task-1781533129031-4rzakq` to investigate unifying the exit-menu actions and
   whether `DropdownMenuItem` should grow a pending affordance.
2. **Label: stable label + spinner.** Where a site swaps its label while pending
   (`{isPending ? "Building…" : "Build"}`), drop the ternary, keep one stable
   label, and let the spinner convey pending. Less layout shift; the spinner is
   the indicator.

## Migration rules

- **Category A, purely-pending** (`disabled={pending}`): →
  `loading={pending}`. Drop any label-swap ternary → stable label.
- **Category A, mixed** (`disabled={pending || !valid}`): split into
  `loading={pending} disabled={!valid}`. Both props are OR'd at render, so the
  validation guard still disables. Drop the label-swap ternary.
- **Category B, fire-and-forget** (`onClick={() => void foo()}` where `foo`
  returns a promise): change to `onClick={() => foo()}` so the returned promise
  drives auto-pending. The arrow returns the promise (not floating), so
  `no-floating-promises` is satisfied. No manual state needed.
  - Where a B site already has a `useState` busy flag wired to `disabled` only,
    prefer dropping the manual flag and returning the promise — unless the flag
    guards **other** buttons too (see launch-control below), in which case keep
    the flag for cross-button re-entry and additionally return the promise for
    the local spinner.

## Call sites

Paths relative to `plugins/`. "purely pending" → `disabled`→`loading`;
"mixed" → split.

### Category A — already track pending, only `disabled`

| File | Line | Action | Pending source | Migration |
|------|------|--------|----------------|-----------|
| `ui/plugins/tweakcn/plugins/community-browser/web/components/import-by-url.tsx` | 109 | Import | `importMutation.isPending` | mixed (`!input.trim()`) |
| `ui/plugins/tweakcn/plugins/community-browser/web/components/import-by-url.tsx` | 145 | Delete saved theme | `deleteMutation.isPending` | purely pending |
| `backup/web/components/backup-panel.tsx` | 123 | Run Backup Now | `isPending` | purely pending |
| `build/web/components/build-popover-content.tsx` | 75 | Build | `building` (live sentinel) | purely pending; `onBuild` is async — return promise too |
| `conversations/plugins/summary/web/components/summary-pane.tsx` | 108 | Summarise | `isPending` | purely pending |
| `conversations/plugins/recover/web/components/recovery-view.tsx` | 194 | Restore all | `anyPending` | purely pending |
| `conversations/plugins/recover/web/components/recovery-view.tsx` | 253 | Restore | `pending` | purely pending |
| `conversations/plugins/conversation-view/plugins/resume/web/components/resume-button.tsx` | 35/52 | Resume | `resume.isPending` | mixed (`!canResume`) |
| `…/ask-user-question/web/components/answer-here-button.tsx` | 43 | Answer here | `m.isPending` | purely pending |
| `…/ask-user-question/web/components/answer-form.tsx` | 149/248 | Submit | `m.isPending` | mixed (`!allAnswered`) |
| `conversations/plugins/conversation-view/plugins/launch-prompts/web/components/launch-prompts-button.tsx` | 52 | Launch trigger | `launching` | purely pending |
| `conversations/plugins/agents/web/components/agent-detail.tsx` | 183 | Launch agent | `launching` | mixed (`!prompt.trim()`) |
| `auth/plugins/google/plugins/setup-wizard/web/components/google-setup-pane.tsx` | 193 | Save | `saving` | mixed (`!clientId && !clientSecret`) |
| `auth/web/components/connect-button.tsx` | 23 | Connect | `busy` | purely pending; inline async onClick |
| `auth/web/components/default-provider-row.tsx` | 147/156/166 | Reconnect/Disconnect/Connect | `busy` | purely pending |
| `tasks/plugins/task-draft-form/web/components/task-draft-form.tsx` | 282 | + task | `submitting` | purely pending |
| `tasks/plugins/task-draft-form/web/components/task-draft-form.tsx` | 292 | Cancel | `submitting` | purely pending |
| `tasks/plugins/task-draft-form/web/components/task-draft-form.tsx` | 295 | Submit chain | `submitting` | mixed (`hasEmpty`) |
| `debug/plugins/broadcasts/web/components/broadcasts-panel.tsx` | 232 | Add broadcast | `saving` | mixed (`!message.trim()`) |
| `debug/plugins/broadcasts/web/components/broadcasts-panel.tsx` | 278 | Delete entry | `saving` | purely pending |
| `debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` | 221 | Delete N safe | `loading`/`deletingSteps` | mixed (`safeCount === 0`) |
| `debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` | 227 | Reload | `loading` | purely pending |
| `debug/plugins/profiling/plugins/runtime/web/components/runtime-section.tsx` | 165 | Reset window | `resetMutation.isPending` | purely pending |
| `infra/plugins/events-test/web/components/events-test-view.tsx` | 282/306/350/425 | Subscribe/Emit/Enqueue/Sweep | `subBusy`/`emitBusy`/`deBusy`/`dtBusy` | purely pending |
| `screenshot/plugins/draw-on-app/web/components/live-draw-overlay.tsx` | 125 | Cancel | `busy` | purely pending |
| `screenshot/plugins/draw-on-app/web/components/live-draw-overlay.tsx` | 128 | Done | `busy` | mixed (`strokes.length === 0`) |
| `screenshot/web/components/screenshot-button.tsx` | 66 | Screenshot (IconButton) | `busy` | purely pending |
| `conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx` | 236 | Push & Close / Send / Stop | `busy` (in `disabled` var) | mixed (status/`hasSession`) — extract `busy`→`loading` |

### Category A nuance — `primitives/launch/web/components/launch-control.tsx`

Lines 166 & 217 (launch buttons) use `disabled={busy}` where
`busy = disabled || launching !== null`, and `onClick={() => void launch(...)}`.
`launching` is shared re-entry state across the icon button, the default button,
the per-row launch buttons (line 142), and the keyboard shortcut (line 118).

- Keep `disabled={busy}` (cross-button re-entry guard — auto-pending only
  disables the clicked button).
- Change `onClick={() => void launch(defaultModel)}` → `onClick={() => launch(defaultModel)}`
  so the clicked button shows its own spinner (replaces `MdPlayArrow`).
- Can drop the now-redundant `launching === defaultModel && "opacity-50"`
  className since the spinner conveys the state.

### Category B — fire-and-forget, no feedback (return the promise)

| File | Line | Action | Change |
|------|------|--------|--------|
| `apps/plugins/pages/plugins/page-tree/web/components/delete-page-action.tsx` | 74 | Delete (confirm dialog) | `void onConfirm()` → `onConfirm()` (it's the `Button` primitive) |
| `apps/plugins/story/plugins/shell/web/components/story-gallery.tsx` | 63 | New story | `void newStory()` → `newStory()` |
| `apps/plugins/story/plugins/pages-integration/web/components/story-section.tsx` | 41 | Make this a story | `void markStory(pageId)` → `markStory(pageId)` |
| `apps/plugins/sonata/plugins/sources/plugins/chord-grid/web/components/chord-grid-add-action.tsx` | 62 | New Chord Grid | already `disabled={creating}`; `void create()` → `create()` and migrate to `loading={creating}` |
| `debug/plugins/broadcasts/web/components/broadcasts-panel.tsx` | 118 | Refresh | `void refetch()` → `refetch()` |
| `debug/plugins/memory/web/components/memory-panel.tsx` | 92 | Load/reload | `void loadList()` → `loadList()` |
| `debug/plugins/queue/web/components/queue-view.tsx` | 137/270/420 | Refresh ×3 | `void refetch()` → `refetch()` |
| `page/plugins/editor/web/components/block-editor.tsx` | 575 | Bulk duplicate | `void bulkDuplicate([...])` → `bulkDuplicate([...])` |

For each B site, **verify the handler returns a Promise** (some `refetch`/
`loadList` may already; if a handler isn't async it can be skipped). If the
button is icon-shaped, the spinner replaces the icon — confirm that reads well.

### Out of scope (filed as `task-1781533129031-4rzakq`)

- DropdownMenuItem exit actions: `conversation-view/plugins/{exit,hold-and-exit,drop-and-exit,drop-dependents}/web/components/*.tsx`
- Native `<button>` sites: `ui/.../community-theme-card.tsx`,
  `apps/plugins/deploy/plugins/servers/web/components/add-server-form.tsx`

## Per-site checklist (apply to every migrated site)

1. Move the in-flight portion of `disabled` into `loading`; keep only true
   validation/data guards in `disabled`.
2. Remove label-swap ternaries → stable label.
3. For B sites: drop `void`, return the promise; remove now-dead manual busy
   state only if it isn't used elsewhere.
4. Confirm the handler actually returns a Promise (otherwise no auto-pending —
   keep an explicit `loading` flag).

## Verification

1. `./equin build` from the worktree.
2. `./equin check` — type-check + lint (`no-floating-promises` must still
   pass after the `void`→return changes).
3. Spot-check a representative few in the running app
   (`http://<worktree>.localhost:9000`) with the `e2e/screenshot.mjs` helper —
   it prints the matched button's `disabled` state and captures before/after:
   - Backup “Run Backup Now” (A purely-pending text button)
   - A queue “Refresh” icon button (B, spinner replaces icon)
   - Tweakcn “Import” (A mixed — stays disabled when input empty, spins when valid + clicked)
   Confirm: clicking shows the spinner, the button is disabled during flight,
   re-enables on settle, and mixed sites stay disabled on invalid input without
   spinning.
4. Optional: the existing button-loading bun:test
   (`plugins/primitives/plugins/ui-kit/web/__tests__/button-loading.test.tsx`)
   already covers the primitive; no new tests required for call-site migrations.
