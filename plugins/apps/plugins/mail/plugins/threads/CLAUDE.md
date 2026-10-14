# threads

The Mail app's **one** surface: a single `data-view` at `/mail/threads` over
`mail_threads`, rendered as a Gmail-style list, whose **tabs are the mailboxes**.
One URL, one DataView, eight view instances. There is no route param, no second
thread list, and no sidebar mailbox nav.

## A mailbox is a view instance, and its scope is an ordinary filter

The eight mailboxes are authored view rows in
`config/apps/mail/threads/mail-threads.jsonc` — `inbox`, `starred`, `important`,
`sent`, `drafts`, `all`, `spam`, `trash` — each with a real, **user-editable**
`filter` and the date-desc sort. "Inbox" is definitionally the view whose filter
is `labels contains INBOX`.

The scope therefore travels the completely standard DataView path and nothing
else:

```
active view's `filter`  →  lowered in the browser (operator sets → the filter
language)  →  the `mail.threads`
window tuple's `where`  →  strict decode  →  filterSql  →  SQL
```

There is no `view` field on the query, no server-side scope derivation, no
locked chips. The Filter pill shows `Labels contains Inbox` as an ordinary
removable chip; editing it rewrites the config row and persists. The old "a user
must not pull Spam into Inbox" invariant is retired by decision — that is the
user's call if they set up the filters (v2 design doc).

**The failure mode to know about:** an unresolvable `fieldId`/`operatorId` is a
*dangling* rule — it lowers to nothing in the browser — so a typo in the config
makes a tab silently show every thread rather than error. (The server can no
longer drop a rule: the window codec strict-decodes the filter against
`mailThreads.filterable`.) `web/__tests__/authored-views.test.ts` reads the real
config file, lowers every authored filter through the real tags / bool operator
sets, renames each field to its column and asserts each tab's scope survives —
that test is the guard, keep it green.

## The live collection (`mail.threads`)

`mailThreads` (`core/internal/collection.ts`) is a `liveCollection` over the
`mail_threads` entity — H 100, M 500, default order
`lastMessageAt desc` — served by `serveCollection(mailThreads, { from:
_mailThreads })` (`server/internal/collection.ts`): one table, identity routes
only. The DataView reads it as live key-range pages through `mailThreadsSource`
(`web/internal/source.ts`, `liveDataSource(…, { searchable: ["subject",
"snippet"] })`), so a thread write (sync marking it read, a new message)
refills exactly that thread in the live pages that hold or now admit it — no
revision tick, no refetch of the loaded pages.

- **The account is a scope, stated as data.** The pane reads mail-core's
  `mailAccount` value (the earliest-connected account, `{ id, email } | null`):
  loading is the list's loading state, a failed read its error, `null` the
  not-connected state (the Gmail integration's `GmailAccessEmptyState`: the
  blocker copy + its fix, or "first sync has not run"), and an id mounts the
  list with `source={mailThreadsSource.scoped({ where: { accountId } })}`.
  `accountId` is a filterable column routed like any other, but the DataView
  never offers a scope column to the Filter control, so the user can neither
  name nor widen it
  — under the single-instance ADR the client choosing its own scope is not a
  security boundary. The server never reads `mail_accounts` for the list (a subquery
  there would be a second table the routes cannot see).
- **Declared by fields** (`from: mailThreadsEntityRef`, `pick`, `fields`):
  the list DERIVES its fields — the thread entity's labelled fields, plus
  `labels`, an own `tagsField` the server binds to the `label_ids` jsonb
  column (`columns: { labels: (j) => j.base.labelIds }`). Field ids are the
  persisted vocabulary the authored tabs name. `snippet` (searched) and
  `accountId` (the scope) are listed but off the body
  (`web/internal/presentation.tsx`); `sender` is display-only.
- **Custom columns sort and filter server-side**: `mailThreads.columnScope` is
  this DataView's id (`mail-threads`), so a custom column defined on the list
  binds as `custom.<id>` (P3 of
  `research/2026-09-29-global-scoped-change-routing.md`).

## Web

- **`mailThreadsPane`** (`segment: "threads"`, no params). Two-line `ThreadRow`
  via `viewOptions.list.renderRow` + a leading star; `onRowActivate` pushes
  `threadPane`; `selectedRowId` comes off `threadPane`'s own route param, so the
  open thread's row is highlighted. A settled empty window says "No
  conversations" (never while it loads).
- The derived fields drive the Sort pill (Subject / Date / Messages) and the
  Filter pill, and are the contract the authored config rows are written
  against — rename a field id and the matching config rules go with it.
  **`labels` (type `tags`) is the axis every mailbox tab lives on**: not
  sortable (a jsonb array has no order); its options (`useMailLabelOptions`,
  `FieldPresentation.Register({ owner: mailThreads })`) map label id →
  friendly name (system ids locally, user labels from `mail-core`'s
  `mailLabels` — the system ids alone while it is pending, never a pending
  field: every tab filters by `labels`), which keeps "Label_12" off the
  screen.

## Boundaries

Consumes only barrels: `mail-core` (schema/types, `mailAccount`, `mailLabels`,
`_mailThreads`), `reading-pane/web` (`threadPane`), `integrations/gmail/web`
(the not-connected state), and the data-view / network-live / pane primitives.
It must **never** be imported by the mail `shell` (that would cycle) — the
`/mail` landing repoint is the route STRING `/mail/threads`.

## E2E

- `e2e/mailbox-tabs-verify.ts` — the tabs are the mailboxes, each returns its
  own rows, and the scope rule is editable and persists. It reads each tab once
  its list SETTLED (rows or the empty state, stable across two reads; a failed
  read throws), and on a seeded worktree compares each tab's exact row set.
- `e2e/threads-live-verify.ts` — seeds synthetic threads for the connected
  account (`e2e/fixture.ts` reads it from the `mailAccount` value over HTTP, and
  refuses main), then writes them in the DB and asserts the open list
  follows without a reload: a new message moves a thread to the top, a label
  change drops it out of Inbox.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The Mail app's one mail surface (/mail/threads): a single DataView over mail_threads whose TABS are the mailboxes — each an authored view instance whose scope is an ordinary, user-editable filter — read as live key-range pages of the `mail.threads` collection, scoped to the connected account. Threads DataView server: serves the `mail.threads` live collection over mail_threads — the active tab's whole filter (mailbox scope included) and the pane's account scope compile into each window tuple, and the routed change feed refills exactly the threads a write touches.
- Web:
  - Slots: `mailThreadsPane.Actions`
  - Slot contributors: `mailThreadsPane.Actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "mail-threads"
    - `FieldPresentation.Register` "collection:mail.threads"
  - Uses:
    - `apps/mail/reading-pane.threadPane`
    - `integrations/gmail.GmailAccessEmptyState`
    - `network/live.FieldPresentation`
    - `network/live.LiveFieldOption`
    - `network/live.useLive`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/data-view.DataView`
    - `primitives/data-view.defineDataView`
    - `primitives/data-view.liveDataSource`
    - `primitives/live-state.foldResource`
    - `primitives/live-state.matchResource`
    - `primitives/pane.defineRoute`
    - `primitives/pane.Pane`
    - `primitives/pane.PaneChrome`
    - `primitives/pane.useOpenPane`
    - `primitives/relative-time.RelativeTime`
    - `ui/icons.Icon`
  - Exports (values): `mailThreadsPane`
- Server:
  - Contributes:
    - `resource.declare` "mail.threads"
    - `resource.declare` "mail.threads:groups"
    - `resource.declare` "mail.threads:rows"
  - Uses:
    - `apps/mail/mail-core._mailThreads`
    - `network/live.serveCollection`
  - Resources:
    - `mail.threads` (keyed, window)
    - `mail.threads:groups` (push)
    - `mail.threads:rows` (keyed, point)
- Core:
  - Uses:
    - `apps/mail/mail-core.mailThreadsEntityRef`
    - `fields/tags/config.tagsField`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
  - Exports (types): `MailThreadRow`
  - Exports (values): `mailThreads`

<!-- AUTOGENERATED:END -->
