# Mail inbox as a standard DataView

**Date:** 2026-07-03
**Category:** apps (mail)
**Status:** Plan — awaiting approval

## Context

The Mail app's inbox (`thread-list` plugin) is a hand-rolled `useInfiniteQuery` +
`VirtualRows` list — it does **not** use the generic `data-view` primitive (the
Notion-like multi-view data surface used by `all-conversations`, `deploy/servers`,
`workflows`, etc.). We want the inbox to be a **standard DataView** so it gains the
shared sort / filter / search / keyset-pagination chrome for free and becomes part of
the composable data-surface story.

This task ships **one new plugin** rendering **one view**: the **default mailbox**
(the inbox = "is not archived"). It sits **alongside** the current
`thread-list`/`mailbox` (nothing deprecated is removed yet). A **future task** removes
the deprecated views once this is validated.

### Decisions (confirmed with user + design constraints)

- **Single plugin, single DataView, views via config — not an umbrella with per-view
  sub-plugins.** With the universal `DataView`, the multi-view axis is the DataView's
  config file (`config/.../<id>.jsonc` `views[]`), not plugins. A per-view sub-plugin
  would carry nothing the config doesn't already express. Future mailboxes (Starred,
  Sent, labels) become additional config view-instances (or a future primitive
  extension — see Risks), not new plugins.
- **View type: list** (Gmail-style single row per thread).
- **Reachability: new `Mail.Sidebar` entry _and_ repoint bare `/mail` to land on it.**
- **"Is not archived" is a server-fixed scope, not a visible/removable filter chip.**
  There is no `archived` column — "not archived" == the thread carries the Gmail
  `INBOX` label (`label_ids @> '["INBOX"]'::jsonb`), i.e. the existing `inbox` system
  view. The generic `server-query` column-map binds fields to a physical
  `AnyColumn` and cannot carry a jsonb-containment SQL expression, so the constraint
  is applied as a **server-fixed `AND` predicate** reusing mail-core's tested
  `mailViewFilterSql` — exactly mirroring `all-conversations`' fixed
  `ne(kind,"system")`. This is also the correct semantics for an inbox (users
  shouldn't be able to remove the scope and pull spam/trash/sent into "Inbox").

## Precedent to mirror

`plugins/conversations/plugins/all-conversations/` — a server-delegated DataView over
`conversations_v` with keyset pagination, a fixed baseline filter, and a scalar
revision tick. Mirror its file layout closely:

- `web/panes.tsx` — `defineDataView` + `<DataView dataSource={…} onRowActivate={…}/>`
- `core/internal/fields.ts` — plain-data field vocabulary (browser+server safe)
- `web/internal/fields.tsx` — derive `FieldDef[]` (adds `value`/`cell`)
- `core/internal/endpoints.ts` — endpoint contract (`FilterGroupSchema`, `SortRuleSchema`)
- `server/internal/handle-query.ts` — `compileWhere` + fixed filter + keyset seek
- `server/internal/column-map.ts` — `FieldColumnMap`
- `config/conversations/all-conversations/all-conversations.jsonc` — the authored view

Key reused APIs: `compileWhere`/`buildSortKeys`/`orderByClauses`/`seekPredicate`/
`keyValuesOf` (`data-view/server-query/server`), `encodeCursor`/`decodeCursor`/
`sortSignature` (`.../server-query/core`), `resolveFieldFilterSql`
(`fields/server-capabilities/server`), `mailViewFilterSql` + `MAIL_SYSTEM_VIEWS` +
`resolveMailAccountId` + `_mailThreads` + `MailThreadSchema` (mail-core),
`threadPane` (reading-pane/web), `sidebarNavItem` (app-shell/web), `Mail` slot +
`MAIL_APP_PATH` (mail shell).

## Plugin: `plugins/apps/plugins/mail/plugins/inbox/` (pluginId `apps.mail.inbox`)

### New files

- **`package.json`** — `@singularity/plugin-apps-mail-inbox`, mirror `thread-list/package.json`.
- **`CLAUDE.md`** — short prose: DataView-backed inbox; server keyset query; fixed
  INBOX scope; independent revision tick; landing + sidebar wiring.

- **`core/internal/fields.ts`** — plain data (no React/drizzle):
  `MailThreadFieldType = "text"|"date"|"bool"|"int"`, `MailThreadFieldSpec
  { id; label; type; primary?; sortable?; filterable?; nullable? }`, and
  `MAIL_INBOX_FIELDS: MailThreadFieldSpec[]`:

  | id | type | flags | column-mapped (server sort/filter) |
  |---|---|---|---|
  | `subject` | text | `primary`, `sortable`, nullable | yes |
  | `lastMessageAt` | date ("Date") | `sortable`, nullable, `align:"end"` | yes |
  | `unread` | bool | filterable | yes |
  | `starred` | bool | filterable | yes |
  | `important` | bool | filterable | yes |
  | `hasAttachments` | bool ("Attachment") | filterable | yes |
  | `messageCount` | int ("Messages") | `sortable` | yes |

  `sender`/`snippet` are **display-only** (rendered inside `renderRow`), not FieldDefs —
  avoids dead sort/filter axes; server search covers subject/snippet via ilike.

- **`core/internal/endpoints.ts`** — `SortRuleSchema` (`{fieldId, direction:"asc"|"desc"}`),
  `QueryInboxBodySchema = { sort: SortRuleSchema[], filter: FilterGroupSchema.nullable(),
  query: string, cursor: string.nullable(), limit: int().positive().max(200) }`,
  `QueryInboxResponseSchema = { items: MailThreadSchema[], nextCursor: string.nullable(),
  hasMore: boolean }`, and
  `queryInbox = defineEndpoint({ route: "POST /api/mail/inbox/query", body, response })`.

- **`core/internal/resources.ts`** — `inboxRevisionResource =
  resourceDescriptor<{rev:string}>("mail-inbox-revision", …, {rev:""})`. **Distinct id**
  from thread-list's `"mail-threads-revision"` (a fresh independent tick — do not couple
  the new plugin to the to-be-deleted thread-list).

- **`core/index.ts`** — barrel re-exporting the above.

- **`server/internal/column-map.ts`** — `COLUMN_MAP: FieldColumnMap` over `_mailThreads`
  for the seven mapped ids (`subject`/`lastMessageAt` nullable).

- **`server/internal/handle-query.ts`** — near-verbatim `all-conversations` handler:
  - `const accountId = await resolveMailAccountId(); if (!accountId) return {items:[], nextCursor:null, hasMore:false};`
  - `where = and(eq(_mailThreads.accountId, accountId),
    mailViewFilterSql(MAIL_SYSTEM_VIEWS[0]!.filter), searchWhere(query),
    compileWhere(filter, COLUMN_MAP, resolver), seek)` — the INBOX predicate replaces
    `ne(kind,"system")`.
  - `searchWhere` = ilike over `_mailThreads.subject`, `_mailThreads.snippet`.
  - tiebreaker `{ col: _mailThreads.id, fieldId: "id" }`; cursor sort-signature guard;
    `encodeCursor(keyValuesOf(...), sortSignature(sort))`.

- **`server/internal/revision-resource.ts`** — clone of `thread-list/server/internal/resource.ts`
  bound to `inboxRevisionResource` (`count()`+`max(updatedAt)` over `_mailThreads`,
  `mode:"push"`, `identityTable:"mail_threads"`, `debounceMs:250`).

- **`server/index.ts`** — eager-import `fields/server-capabilities-loader/server`;
  contribute `Resource.Declare(inboxRevisionServerResource)`; register
  `{ [queryInbox.route]: implement(queryInbox, handleQuery) }`.

- **`web/internal/sender-summary.ts`** — small re-implementation of thread-list's
  `senderSummary` (do not reach into thread-list's `internal/`).

- **`web/internal/fields.tsx`** — map `MAIL_INBOX_FIELDS → FieldDef<MailThread>[]`,
  adding `value` per id and a `RelativeTime` `cell` for `lastMessageAt`.

- **`web/components/inbox-row.tsx`** — the rich two-line Gmail row copied from
  `thread-list/web/components/thread-row.tsx` (star leading, sender + important/attachment
  markers + `RelativeTime` on line 1, subject + snippet on line 2, bold on `unread`)
  **minus** its own `openPane` (activation is owned by the DataView). Signature
  `({thread}: {thread: MailThread}) => ReactNode`.

- **`web/panes.tsx`**:
  ```tsx
  const MAIL_INBOX_VIEW = defineDataView("mail-inbox");
  export const inboxPane = Pane.define({ id: "mail-inbox", segment: "mailbox",
    component: InboxPaneView, width: 520, resolve: false });
  // InboxPaneView: useResource(inboxRevisionResource) → changeTick (matchResource),
  // <PaneChrome pane={inboxPane} title="Inbox">
  //   <DataView<MailThread> storageKey={MAIL_INBOX_VIEW} rows={[]} fields={inboxFieldDefs}
  //     rowKey={t=>t.id} views={["list"]}
  //     viewOptions={{ list: { size:"md",
  //       leading: t => t.starred ? <MdStar…/> : <MdStarBorder…/>,
  //       renderRow: t => <InboxRow thread={t}/> } }}
  //     dataSource={{ changeTick, fetchPage: args => fetchEndpoint(queryInbox, {}, {body:args}) }}
  //     onRowActivate={t => openPane(threadPane, {threadId:t.id}, {mode:"push"})} />
  ```

- **`web/index.ts`** — export `inboxPane`; contribute `Pane.Register({pane:inboxPane})`
  and `Mail.Sidebar({ id:"inbox", ...sidebarNavItem({ title:"Inbox", icon:MdInbox,
  onClick: () => openPane(inboxPane, {}, {mode:"root"}) }) })`.

- **`config/apps/mail/inbox/mail-inbox.jsonc`** — the single authored view (satisfies the
  `data-view:configs-authored` check). Body (build stamps the `@hash` + `.origin` twin):
  ```jsonc
  { "views": [ { "name": "Inbox",
    "view": { "type": "list", "sort": [{ "fieldId": "lastMessageAt", "direction": "desc" }] } } ] }
  ```

### Edited file (1)

- **`plugins/apps/plugins/mail/plugins/shell/web/components/mail-root.tsx`** — repoint the
  ready-redirect from `openPane(mailboxViewPane, {view:DEFAULT_MAIL_VIEW}, {mode:"root"})`
  to **`navigate(`${MAIL_APP_PATH}/mailbox`)`** (add `MAIL_APP_PATH` from `../slots`;
  `navigate` is already imported). Remove the now-unused `mailboxViewPane` / `useOpenPane`
  / `DEFAULT_MAIL_VIEW` imports.

  **Why URL, not the pane object:** the new plugin must import the mail shell for the
  `Mail.Sidebar` slot (`inbox → shell`). If `mail-root` imported `inboxPane`
  (`shell → inbox`) we'd form a forbidden plugin cycle. Navigating by route string
  keeps `inbox → shell` one-way and acyclic — structurally identical to
  `all-conversations → shell`. Panes are addressed by URL segment, so
  `navigate("/mail/mailbox")` mounts `inboxPane` as the Miller root exactly like
  `openPane(..., {mode:"root"})`.

### Build-regenerated (via `./equin build`, never hand-edited)

- `data-view/shared/data-views.generated.ts` gains `{ id:"mail-inbox", pluginId:"apps.mail.inbox" }`
  (`data-views-in-sync` check fails until regenerated).
- `web.generated.ts` / `server.generated.ts` auto-discover the new barrels.
- `.jsonc` `@hash` + `.origin.jsonc` stamping.

## Verification

1. `./equin build` — regenerates `data-views.generated.ts` (mail-inbox entry);
   passes `data-views-in-sync`, `data-view:configs-authored`, `plugins-registry-in-sync`,
   `plugin-boundaries` (no cycle), and `type-check` (confirms column-map `AnyColumn`
   typing + endpoint schemas).
2. Open bare **`http://<worktree>.localhost:9000/mail`** (Gmail connected) → URL becomes
   `/mail/mailbox`; the pane shows the **DataView list** of INBOX threads newest-first,
   with an **Inbox** entry in the Mail sidebar. Screenshot via `e2e/screenshot.mjs`.
3. Click a row → `threadPane` opens as a pushed Miller column (reading-pane).
4. Toolbar: Sort pill (Date/Subject/Messages), Filter pill (Unread/Starred/Important/
   Attachment — compile to SQL server-side), search box (ilike subject/snippet). Scroll →
   keyset pagination; a thread write pulses `mail-inbox-revision` and refetches the loaded
   window in place (no scroll reset).
5. Confirm archived / non-INBOX threads never appear (fixed `label_ids @> '["INBOX"]'`).

## Risks / follow-ups

- **Landing repoint mechanism.** Cycle-avoidance relies on `navigate("/mail/mailbox")`
  resetting the Miller root cleanly (expected — the stack derives from the URL). Fallback
  if not: a two-plugin split (keep pane/query/config/revision in `inbox` with no shell
  import so `shell → inbox` is legal for the landing; move the `Mail.Sidebar` contribution
  to a tiny `inbox-nav` web plugin). Guaranteed acyclic, two plugins.
- **"Not archived" is enforced, not a chip.** Deliberate (see Decisions). A user-visible/
  removable archived filter would need either a stored generated column
  (`archived GENERATED ALWAYS AS (NOT (label_ids @> '["INBOX"]')) STORED`, a migration +
  `mailThreadFields`/wire-schema change) or widening the shared `ColumnBinding.col` to
  `AnyColumn | SQL` + registering a jsonb-containment operator. Either is the clean path
  when future mailboxes (Starred/Sent/labels) become sibling config view-instances with
  their own `view.filter`s — a separate task, not this one.
- **Sort null-ordering.** thread-list uses `COALESCE(last_message_at, created_at) DESC`;
  the generic keyset uses `last_message_at DESC NULLS LAST, id`. Threads with null
  `lastMessageAt` sort last rather than interleaving by `createdAt`. Near-invisible for a
  synced inbox; for exact parity, add `createdAt` to the column-map + a secondary sort rule.
