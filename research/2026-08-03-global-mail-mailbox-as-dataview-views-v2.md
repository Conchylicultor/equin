# Mail mailboxes as DataView tabs — v2 (supersedes v1)

## Context

v1 (`2026-08-03-global-mail-mailbox-as-dataview-views.md`) shipped, and the
user rejected two of its load-bearing decisions on review. This doc records the
corrected design; v1 is kept only for the evolution trail.

**What v1 got wrong:**

1. **Mailboxes as route params.** v1 made every mailbox a URL
   (`/mail/v/inbox`, `/mail/v/sent`, …) sharing one DataView. The user reads
   that as "a separate DataView per URL" — and functionally they are right: the
   mailbox axis lived outside the view switcher, so each mailbox was its own
   surface carrying a lone "Threads" tab. **Wanted: ONE url, ONE DataView, the
   mailboxes as tabs.**
2. **The locked scope.** v1 rendered the mailbox filter as a non-removable
   chip, preserving the pre-existing invariant *"a user must not be able to pull
   spam/trash/sent into Inbox"*. The user's ruling: **that is the user's
   decision if they set up the corresponding filters.** A DataView whose filters
   can't be edited defeats the point of a configurable DataView.

The two were coupled: a route param has nowhere to persist an edited filter, so
editable filters *require* persisted view instances. Fixing (1) is what makes
(2) possible.

**Resolution of the labels problem.** v1 chose route params because unbounded,
runtime-created user labels cannot be config-authored view rows. The user's
answer: **drop label mailboxes entirely.** Labels stop being views and remain a
*filterable field* — anyone wanting a "Promotions" view builds one from the
Labels field, or filters ad hoc. The static/dynamic split that forced v1's hand
disappears.

## The design

**One pane, one DataView, eight authored view instances.** The mailbox is a
tab, its scope is that tab's ordinary `filter`, and the user can edit it.

The scope now travels the **completely standard** path: the active view's
`filter` → the request body's `FilterGroup` → `compileWhere` → SQL, using the
`tags` filter-SQL from v1. There is no bespoke scope machinery left:

- no `view` field on the query body
- no server-side scope derivation (`mailViewScopeSql`, `resolveMailView`)
- no `DataViewProps.baseFilter`, no locked chips
- no route param

"Inbox" is definitionally the view whose filter is `Labels contains INBOX`. If
a user edits it, that is the answer — there is no invariant left to violate, so
there is nothing to enforce.

### Survives from v1 (do NOT revert)

- **`tags` server `filter-sql` + `storage`** — load-bearing: without jsonb
  containment SQL, `Labels contains INBOX` is not expressible, so the tabs
  cannot work at all.
- **GIN index** on `mail_threads.label_ids` — every tab's filter is now a `@>`
  containment predicate on the standard path.
- The `threads` plugin, its DataView, the `labels` field + friendly
  `FieldDef.options`, and the `selectedRowId` fix.

### Reverted from v1

- `DataViewProps.baseFilter`, `LockedFilterRules`, `describe-filter-rule.ts`,
  the `useFilterController` base plumbing, `data-view-body` wiring, and
  `base-filter.test.tsx` — the whole locked-filter capability.
- `mail-core/core/internal/base-filter.ts` (`mailViewBaseFilter`,
  `MAIL_THREAD_FIELD_IDS`).
- `threads/server/internal/where.ts`'s scope derivation; `view` on the endpoint.
- The `v/:view` pane segment.

### Newly dead code to remove

With no route param and no sidebar mailbox nav, the view *vocabulary* loses its
consumers. Verify by grep before deleting each: `MAIL_SYSTEM_VIEWS`,
`parseMailView`, `resolveMailView`, `labelViewId`, `mailViewLabelId`,
`MailViewFilter`, `mailViewFilterSql`, `view-sql.ts`. The filters now live as
plain `FilterGroup` JSON in the config doc, not as a TS vocabulary.

## The view rows

Eight rows in `config/apps/mail/threads/mail-threads.jsonc`, each a real
editable filter. Every row needs an explicit bare-slug `id`
(`config-stable-list-ids`) and carries the date-desc sort:

| id | name | filter |
|---|---|---|
| `inbox` | Inbox | `labels contains INBOX` |
| `starred` | Starred | `starred is true` |
| `important` | Important | `important is true` |
| `sent` | Sent | `labels contains SENT` |
| `drafts` | Drafts | `labels contains DRAFT` |
| `all` | All Mail | `labels does-not-contain SPAM` **and** `does-not-contain TRASH` |
| `spam` | Spam | `labels contains SPAM` |
| `trash` | Trash | `labels contains TRASH` |

Copy the authored-row shape from
`config/conversations/all-conversations/all-conversations.jsonc`.

## Open: the sidebar and unread counts

With mailboxes as tabs, `mailbox`'s sidebar nav shows the same axis as the tab
strip — redundant, and its label rows are being retired anyway. It should go.

**But that drops the per-mailbox unread badges, which are real Gmail-class
value.** Do not silently lose them. Investigate whether the view switcher can
carry a per-tab badge:

- if yes → move the counts there and delete `mailbox`;
- if no → **report before dropping**; keeping a reduced sidebar or deferring the
  deletion is the user's call, not the implementer's.

Note `mailViewCountsResource` is also the source of an observed 1095ms slow-op,
so whatever happens to it, it wants a look.

## Verification

- `./equin build && ./equin check`.
- One URL, a tab strip of 8 mailboxes; switching tabs re-scopes the list.
- **Filters are editable**: open Inbox's Filter pill, the `Labels contains
  Inbox` rule is an ordinary removable/editable chip; edits persist across
  reload (config write-back).
- Opening a thread highlights its row.
- No `/mail/v/*` route remains; bare `/mail` lands on the single threads pane.
