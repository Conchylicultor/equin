# Mail mailboxes as DataView views (with a visible, locked scope)

## Context

Opening `/mail/mailbox` shows an "Inbox" DataView with **no filter explaining why
it only shows inbox mail**. The scope is a server-side constant
(`inbox/server/internal/handle-query.ts:53`), invisible to the user and
un-inspectable from the UI. The expected mental model — and the right one — is:
*one DataView over all mail, with a view per mailbox, each carrying a filter you
can see.*

Worse, there are currently **two** mailbox surfaces shipping side by side:

| Surface | Route | Coverage |
|---|---|---|
| `thread-list` + `mailbox` (old, hand-rolled) | `/mail/v/:view` | all 8 system views + user labels |
| `inbox` (new, DataView) | `/mail/mailbox` | INBOX only |

Both appear in the Mail sidebar today ("Mailboxes" and "Inbox"). The `inbox`
plugin's own doc states the intent: retire the old pair once validated. This
plan does that, and closes the legibility gap that prompted it.

**Outcome:** one route-parameterized DataView serving every mailbox and every
user label, where the mailbox scope renders as a **visible but non-removable**
filter chip, and labels become a genuinely filterable dimension users can build
their own filters on.

## Decisions

### The locked scope is a render-only prop, not persisted view state

data-view has no locked-filter concept. The tempting design — add
`baseFilter` to the persisted `view` blob — is the wrong one:

- The persisted `filter` is replaced wholesale by
  `setFilter → updateView(id, {filter}, {merge:true})`. Anything sharing that
  tree needs every write path to preserve it, and a miss **fails open** (scope
  silently lost → Spam leaks into Inbox). Security invariants must not depend on
  client write paths being bug-free.
- It would extend a config-persisted schema used by every DataView consumer in
  the repo, with a config round-trip and descriptor change to match.

Instead:

```ts
// DataViewProps
/** Read-only scope this surface is bound to. Rendered as non-removable chips in
 *  the Filter pill. The HOST is responsible for applying it server-side — the
 *  primitive never sends it anywhere. */
baseFilter?: FilterGroup;
```

Purely presentational, zero persistence, zero blast radius on existing
consumers. The chip explains the scope; it does not *enforce* it.

### Enforcement lives server-side, derived from the view id — never from the body

The scope must be **re-derived on the server from the route's view id**, never
read from the request body. A client that omits or rewrites a body field must
not be able to widen its own scope. Both runtimes derive the same scope from the
same pure function, so the visible chip and the enforced predicate cannot drift:

```ts
// mail-core/core — pure, web-safe, the single source of truth
export function mailViewBaseFilter(view: string): FilterGroup   // "inbox" | "label:Label_12" | …
```

- **Web** renders it via `baseFilter` → locked chips.
- **Server** resolves the view id → `MailViewFilter` → SQL, ANDed outside
  `compileWhere`, exactly as today's fixed predicate is.

The scope never travels in the request body at all. The security property is
structural, not a validation.

### Every mailbox is a route param — including system ones

Config-authored view instances cannot represent user labels (unbounded DB rows;
`config-stable-list-ids` requires author-chosen static ids). Rather than split
the model — config views for system mailboxes, something else for labels — treat
**all** mailboxes uniformly as route params, reusing `mail-core`'s existing
`parseMailView` vocabulary. Uniform, no special cases, and already proven: this
is precisely what `thread-list`'s `v/:view` pane does today.

The DataView keeps ONE authored view row (list, date-desc). Users can still add
their own views on top; the mailbox axis is orthogonal to that.

### `tags` gains its missing server half — no new field type

`mail_threads.label_ids` is a `jsonb` string array. The `tags` field type already
has exactly the right client-side operators (`contains`, `does-not-contain`,
`contains-any-of`, `contains-all-of`, `is-empty`, `is-not-empty`) in
`fields/tags/plugins/filter/web/internal/tags-filter-logic.ts` — it is simply
missing `filter-sql` and `storage`, so any `tags` rule is silently dropped by
server-delegated `compileWhere`. Add the server twin rather than mint a new type.
This fixes the gap for *every* future consumer, not just mail.

## Plan

### 1. `tags` server capabilities — `plugins/fields/plugins/tags/plugins/`

- `storage/server/` — `Fields.Storage({type: tagsFieldType, build: (name) => jsonb(name).$type<string[]>()})`. Mirror `fields/json/plugins/storage`.
- `filter-sql/server/` — `Fields.FilterSql({type: tagsFieldType, operators: tagsFilterSql})`. Mirror the shape and NULL discipline of `fields/enum/plugins/filter-sql/server/internal/enum-filter-sql.ts`.

Truth-table parity with the JS predicates is the whole game. The JS side treats a
missing array as `[]`; SQL `NULL @> x` is `NULL`, not `false`. So coalesce, and
OR the NULL branch back in on negative operators:

```ts
contains:            sql`COALESCE(${col}, '[]'::jsonb) @> ${JSON.stringify([tag])}::jsonb`
does-not-contain:    sql`NOT (COALESCE(${col}, '[]'::jsonb) @> ${JSON.stringify([tag])}::jsonb)`
contains-any-of:     OR over each tag's containment
contains-all-of:     sql`COALESCE(${col},'[]'::jsonb) @> ${JSON.stringify(list)}::jsonb`   // @> is superset — all at once
is-empty:            sql`COALESCE(jsonb_array_length(COALESCE(${col},'[]'::jsonb)), 0) = 0`
```

Empty operand → return `undefined` (rule dropped, never a 400), matching both the
JS predicates' permissive-on-empty behavior and the builder contract.

⚠️ **Verify before committing:** adding a storage builder for `tags` could alter
generated DDL for any existing entity already using a tags-typed field in a
`defineEntity` FieldsRecord. Grep for tags-typed entity fields; if any exist,
confirm `./equin build` generates no unexpected migration.

`eager.generated.ts` is regenerated by `./equin build` (`fields-eager-in-sync`) — never hand-edit.

### 2. `baseFilter` in data-view — `plugins/primitives/plugins/data-view/`

- Add `baseFilter?: FilterGroup` to `DataViewProps` (`core/internal/types.ts`), threaded to the Filter pill.
- Filter UI (`web/components/filter/`): render base rules ahead of the editable tree as chips with **no remove affordance** and no click-to-edit. `setFilter`, clear-all, conjunction switching and "Add filter" must all operate **only** on the editable tree — the base tree is not part of `state.filter` and must never be merged into it.
- The Filter pill's active-count badge should include base rules (they *are* filtering), but clear-all must not clear them.

Keep the change additive: absent `baseFilter`, behavior is byte-identical for every existing consumer.

### 3. `mail-core` — the shared vocabulary and the index

- Add `mailViewBaseFilter(view: string): FilterGroup` in `core/`, built on the existing `parseMailView` / `MailViewFilter`. Maps `{kind:"label"}` → a `labels contains <id>` rule, `{kind:"flag"}` → `starred`/`important` is true, `{kind:"allMail"}` → does-not-contain SPAM + does-not-contain TRASH.
- **Move `mailLabelsResource` here from `mailbox`.** The pane plugin needs label names for readable chips, and the sidebar needs them too; hosting it in the shared data layer (which imports nobody) keeps both consumers acyclic.
- Add the missing GIN index on `label_ids` — every mailbox predicate is a containment scan today and consolidating all mailboxes onto one query path makes it hotter. Confirm the repo's drizzle GIN precedent (`grep -r '.using("gin"'`) and prefer `jsonb_path_ops`. Regenerate via `./equin build`; commit the migration (`migrations-in-sync`).

### 4. `inbox` → `threads` — the single mailbox surface

Rename the plugin (a plugin named `inbox` that serves Spam is a lie). Data-view
id `mail-inbox` → `mail-threads`; config moves to `config/apps/mail/threads/mail-threads.jsonc`, carrying the `sort: [{fieldId:"lastMessageAt",direction:"desc"}]` row.

- Pane becomes `Pane.define({ id:"mail-threads", segment:"v/:view", resolve:false })`, replacing **both** `inboxPane` and `thread-list`'s `mailboxViewPane`. `/mail/mailbox` is retired.
- Title comes from the resolved view (system title from `MAIL_SYSTEM_VIEWS`, friendly label name from `mailLabelsResource`) — this is what `thread-list`'s `mailViewTitle()` had to punt on; hosting labels in `mail-core` solves it.
- Add a `labels` field (type `tags`) to the field schema + `COLUMN_MAP` (`{col: _mailThreads.labelIds, type:"tags"}`), with `FieldDef.options` computed from `mailLabelsResource` + the system labels, so filter chips read "Promotions", not "Label_12".
- `baseFilter={mailViewBaseFilter(view)}` on the `<DataView>`.
- Server: derive the scope from the **view route param**, not the body. Delete the `INBOX_FILTER` constant.
- **Fix the highlight regression:** pass `selectedRowId={threadPane.useRouteEntry()?.params.threadId}` — the old list had this, the DataView never wired it.

### 5. Sidebar repoint + `thread-list` deletion

- `mailbox` keeps the sidebar, system-view rows, live label rows and unread badges (`mailViewCountsResource` stays put — it is a sidebar concern), but now navigates to the new pane and derives its active highlight from it. Two files: `web/components/mailbox-nav.tsx`, `web/internal/use-selected-mail-view.ts`.
- Delete `plugins/apps/plugins/mail/plugins/thread-list/` entirely — it is imported by `mailbox` and nothing else. This retires the duplicated `sender-summary.ts`, the second revision resource, `thread-row.tsx`, the bespoke cursor codec and `mailViewTitle()`.
- Drop the now-redundant "Inbox" sidebar entry (`config/apps/mail/shell/mail.sidebar.jsonc`); "Mailboxes" covers it.
- Shell landing: `shell/web/components/mail-root.tsx:30` → `/mail/v/inbox`. Keep it a **literal string** — shell must never import the pane plugin (acyclicity).

### Import DAG after

```
mail-core  (labels resource, view vocabulary — imports nobody)
   ↑            ↑
threads     mailbox (sidebar) → threads
   ↓
reading-pane
```
No cycles; `shell` stays a sibling leaf.

## Order

Each step leaves the repo building and `./equin check` green:

1. `tags` storage + filter-sql *(independent subtree)*
2. `baseFilter` + locked chips in data-view *(independent subtree)*
3. `mail-core`: base-filter resolver, labels resource move, GIN index
4. `inbox` → `threads`: route param, view-derived scope, labels field, `selectedRowId`
5. Sidebar repoint; delete `thread-list`; sidebar config; shell landing

Steps 1 and 2 touch disjoint trees and can run in parallel. 3–5 are sequential.

## Verification

- `./equin build` then `./equin check` (expect to satisfy: `fields-eager-in-sync`, `plugins-registry-in-sync`, `plugins-doc-in-sync`, `migrations-in-sync`, `config-stable-list-ids`, `data-views-in-sync`, `plugin-boundaries`, `type-check`).
- `bun test plugins/fields/plugins/tags/` — extend the existing `tags-filter-logic.test.ts` with SQL/JS parity cases, especially NULL and empty-operand.
- Drive the app at `http://<worktree>.localhost:9000/mail/v/inbox`:
  - the Filter pill shows a **non-removable** "Labels contains INBOX" chip;
  - adding "Unread is true" on top narrows correctly and is removable;
  - clear-all removes the user's rule and **keeps** the base chip;
  - `/mail/v/spam`, `/mail/v/sent`, `/mail/v/label:<id>` each scope correctly and show their own chip;
  - opening a thread highlights its row in the list.
- `query_db`: verify the GIN index exists on `mail_threads.label_ids` and that a containment query plans as an index scan (`EXPLAIN`).
- Confirm no request body can widen scope: the query endpoint must ignore any client-supplied label filter that contradicts the view id — the scope is derived, never read from the body.
