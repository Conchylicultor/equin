# Notifications in user terms — implementation plan

Spec: prototype `proto-1792931808-jimks8` (scenes `bell`, `toasts`, `catalog`). The
catalog scene is the source of truth for every headline, subject, action and
"when" rule below; implement it pixel-perfect in the chrome theme.

## Context

An audit of main's `notifications` table (user audience, 7 days: ~1,550 rows,
~220/day) found the bell is mostly noise and reads like internals:

- ~33% are echoes of a click the user just made (`Task created`, `Close`,
  `Drop & Close`, `Resume` — the push-and-exit button even uses its own verb as
  the title).
- ~43% are build plumbing (`Auto-build started` + `Build succeeded` per push,
  build ids, exit codes).
- Descriptions leak internals: raw prompts with `<ui-context>` tags, model
  names, `HTTP 409`, git stderr, minified Lexical errors, "task(s)".
- Rows don't say *what they are about*; chips are raw `type` values
  (`build 661`, `conversation 520`).

Decided with the user while iterating the prototype:

1. **Toast and bell are mirrors.** Every notification is a toast; the bell is
   exactly the list of toasts sent (so a missed toast can always be found).
   Nothing is bell-only; nothing is toast-only. No in-place updating of a toast.
2. **A notification is about a conversation, not a task.** Tasks are machinery;
   the only task-named toast is "Task added" (filed without auto-start).
3. **One shape:** icon · one-line headline (the event, sentence case) · line 2 =
   the subject's name only · at most one action. Same weight for every
   headline; unread is a dot only. In the bell, time top-right with the action
   under it. Internals (build id, exit code, HTTP status, raw error) are a
   developer-only detail.
4. **When to send** — one of four rules per event: *Always* (4s) · *Only if the
   user isn't watching the conversation* (4s) · *Never* (the user saw it happen,
   or only the result matters) · *Always, stays until handled* (errors).
5. **Bell keeps category chips**, in user terms: All · Errors · Conversations ·
   Updates · Automations.

## Design

### 1. The notification model (shell/notifications)

Extend `notificationFields` (`plugins/shell/plugins/notifications/core/entity.ts`)
and `NotificationWrite` (`server/internal/record-notification.ts`):

| field | meaning |
|---|---|
| `title` | headline — the event ("Conversation finished"). Unchanged column. |
| `subjectId` / `subjectName` (new, nullable) | what it is about: a `conv-…` / `task-…` id and its name **as shown at send time** (snapshot, so the bell shows exactly what the toast showed). Line 2. |
| `description` | line 2 only when there is no subject (user-safe text). |
| `detail` (new, nullable) | developer-only: build id, exit code, HTTP status, raw error. Rendered only for a developer reader. |
| `action` (new, nullable JSON `{ kind, payload }`) | the one action; resolved through a registry (§3). |
| `category` (new, NOT NULL, default `other`) | closed list in `core/`: `conversations` · `updates` · `automations` · `reports` · `other`. Drives the chips. |
| `variant` | unchanged; `error` ⇒ sticky toast. |

`recordNotification` gains `unlessWatching?: true` (requires `subjectId`): when
the subject is being watched (§4) nothing is written — so no toast and no bell
row, which keeps the mirror by construction.

The browser endpoint `createNotification` (`shared/endpoints.ts`, used by
`useToast`) takes the same fields. `ToastArgs` (web `toast.ts`) requires
`category`, so every `useToast` caller states one (tsc enforces it — ~40
mechanical call sites).

Migration comes from `./equin build`. Existing rows get `category = other`.

### 2. One component for both surfaces

New `NotificationView` (`web/components/notification-view.tsx`): icon (by
variant/category; red for error, amber for warning, faint otherwise), headline,
line 2 (`subjectName ?? description`), the action button, optional `when`, and
`detail` behind `useAudience() === "developer"` with the `DeveloperMark`.

- **Toast:** the arrival watcher (`web/internal/use-notification-arrivals.ts`,
  called from `bell-button.tsx`) and `useToast` render `NotificationView`
  through a new `showToast({ render, duration })` path in
  `plugins/shell/plugins/toast/web/internal/show-toast.tsx` (sonner custom
  content; keep its microtask publish and `ToastBody` ledger). Duration 4s;
  `variant: error` ⇒ `Infinity` until dismissed or acted on.
- **Bell row:** `notifications-panel.tsx`'s `NotificationRow` renders the same
  `NotificationView` with `when` (relative time) and the unread dot. The old
  `NotificationBody` (type, "this tab", `×count`, coloured title) stays only
  in Debug → Notifications for developers, plus `detail`.
- **Popover:** keep 320px, header (title · mark-all-read icon · View all).
  Chips: `FilterChips` groups by `category` instead of `type`
  (`useReachingNotificationGroups("category")`), labels from the core list;
  Errors chip unchanged (variant). Sections Today / Earlier by `createdAt`.
  Badge semantics unchanged (`shared/unread.ts`: unread errors + warnings).

### 3. Actions as a registry (collection–consumer separation)

New slot `Notifications.Action` (web): `{ kind, label, run(payload, ctx) }`.
`NotificationView` resolves `action.kind` through it; an unknown kind throws
(fail loudly). Contributors own their kinds:

| kind | label | contributor | run |
|---|---|---|---|
| `open` | Open / Review | notifications (core) | `appLink(payload.to)` — replaces `linkTo` click |
| `reload` | Reload | notifications | `location.reload()` |
| `resume` | Retry | `conversation-view/resume` | the existing resume endpoint |
| `fix-build` | Fix | `build/build-fix` | the existing `InvestigateAction` launch for the build run |

No Undo in v1: drop-and-exit deletes the conversation and keeps no prior task
status (follow-up task, below).

### 4. "Is the user watching this conversation?" (new: notifications/plugins/watching)

Nothing tracks this today (`useMarkConversationViewed` is a one-shot "opened"
stamp). Add a small subject-agnostic presence plugin:

- **Web:** `useWatching(subjectId)` — reports watching while the surface is
  focused (`useSurfaceFocused`, apps-core/tabs) **and**
  `document.visibilityState === "visible"`; reports on change only (mount,
  unmount, focus/visibility events — no polling). Called by `ConversationView`
  and `AgentThread`.
- **Server:** in-memory set of `(tabId, subjectId)`; `isWatched(subjectId)`.
  An entry dies with its tab's live connection (verify the resource-runtime
  socket exposes a close hook; if not, that hook is part of this work — a stale
  entry would silently swallow toasts).
- `recordNotification({ unlessWatching: true })` consults it.

### 5. Producers (the catalog, row by row)

| today | becomes | rule | where |
|---|---|---|---|
| Task created (auto-start) | no toast at submit; server sends **Conversation started** · subject conv · Open | unless watching (`shownByLauncher` ⇒ not recorded at all, replacing today's `muted`) | `task-draft-form/web/internal/submit.ts`, `conversations/server/internal/notify-created-job.ts` |
| Task created (no auto-start) | **Task added** · subject task · Open (Tasks) | always | `submit.ts` (`N tasks added` for a chain) |
| Task unblocked | **Conversation unblocked** · subject conv · Open | always | `notify-created-job.ts` (`dep-resolved`) |
| Close / Resume / Task held / Conversation closed (button echoes) | — | never | `push-and-exit-button.tsx` (`successToast`), `exit`, `hold-and-exit`, `resume` buttons |
| Drop & Close | **Conversation dropped** · subject | always | `drop-and-exit-button.tsx` / push-and-exit `drop-and-exit` spec |
| Dependents dropped | **Dropped with N follow-ups** · subject | always | `drop-dependents-button.tsx` |
| Pushed and closed | **Conversation finished** · subject · Open | unless watching | `push-and-exit/server/internal/exit-clean-finalize-job.ts` (title from the conversation row) |
| Closed without pushing | **Finished without changes** · subject | unless watching | same |
| Auto-build started · Build superseded / ended from outside / interrupted | — (latter three → `audience: developer`) | never (user) | `build/machine/internal/run-state.ts` |
| Build succeeded | **equin was updated** · subject = conversation(s) in the build · Reload · category updates | always | `run-state.ts` + §6 |
| Build failed | **Build failed** · subject · Fix · detail = build id, exit code | stays | `run-state.ts` |
| Resume failed | **Couldn't resume conversation** · subject · Retry · detail | stays | `resume-button.tsx` |
| Spawn failed (user-facing) | **Couldn't start conversation** · subject · detail = failed step | stays | spawn job's final failure (`conversations/spawn-failure`) |
| Request failed (HTTP 400) | **<Action> failed** (e.g. "Rename failed", named by the mutation) · subject · Retry · detail = method/route/status | stays | `reports/plugins/mutation-errors/.../mutation-error-watcher.tsx` |
| Editor error | **Message editor crashed** · subject conv · Reload · detail = raw | stays | `prompt-input.tsx` |
| Failed to update dependencies | **Circular dependency not added** · subject | stays | `dependencies-button.tsx` |
| Automation task waiting | **Waiting for you** · subject = automation label · Review · category automations | always | `tasks/plugins/automations/server/internal/attention.ts` |

Other existing producers (auth, models, page reminders, outcome-report, build
popover, screenshot, history, prototypes, debug) only gain a `category` and keep
their wording in this change; a follow-up reviews them against the rules.

### 6. Which conversation(s) a build contains

`build_runs.commitHash` of this run and of the previous finished main build
(`build/machine/internal/wants-build.ts` already reads it) → `git log` over
`prev..commitHash` → `parseTrailerLog` (`tasks-core/core/internal/trailers.ts`)
→ `Singularity-Conversation` ids → conversation titles. One id ⇒ its title;
several ⇒ "Fix login bug and 2 more"; none (a `--from-main` push) ⇒ no subject.
Reuse the git-measured trailer read in `tasks/plugins/attempt-work`.

## Phasing (each lands green and reviewable)

1. Model + `NotificationView` + toast render path + action registry + category
   chips (existing producers render through it unchanged, `category: other`).
2. Producers rewrite (§5) except the two that need §4/§6.
3. Watching presence (§4) → "Conversation finished / without changes".
4. Build attribution (§6) → "equin was updated / Build failed".

## Verification

- `./equin test plugins/shell/plugins/notifications plugins/shell/plugins/toast`
  — extend `web/__tests__/bell-button.test.tsx` (mirror: an arrival renders the
  same `NotificationView` in the toast and the row; sticky errors; chips by
  category; unknown action kind throws) and add `isWatched` / `unlessWatching`
  unit tests.
- Extend `e2e/bell-filter.ts` for the category chips and run it on this
  worktree's build.
- On the build, drive each flow with `browser_*` (file a task, launch one,
  push & close a conversation while watching vs not, drop, a failing resume)
  and compare the toast and the bell against the catalog scene;
  `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1792931808-jimks8`.
- `query_db` on the worktree DB: no rows with `type` build/started, every new
  row has a `category`, `detail` holds the internals.

## Follow-ups (not in this change)

- Undo for drop (needs the prior task status kept and a soft-deleted conversation).
- Review the remaining producers (auth, models, reminders, screenshot…) against
  the four rules.
