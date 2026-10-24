# Page "edited at" as a field of every page row

## Context

Both "recent" surfaces in the Pages app order pages by the page ROW's
`updatedAt`: the sidebar's Recent section (`config/apps/pages/page-tree/pages-sidebar.jsonc`,
field `updatedAt` in `page-tree/web/components/pages-sidebar.tsx`) and the Welcome
page's Recent pages (`apps/pages/welcome/recent-pages`). That timestamp moves on a
rename / cover / kind change / move, never on a content edit (a content edit stamps
only the edited block's own row). The header's "Edited 2h ago" has the right
definition — `readPageEditedAt` (`page/editor/server/internal/resources.ts`): newest
`updated_at` over the page row and its live content blocks (`page_id = P`, sub-page
rows included) — but it is a per-page live value (`pageEditedAt`), not something a
list can sort and window on.

Goal: every page row carries its edit time, both Recent lists sort/filter on it, the
header reads the same field, and the ~1s typing projection recomputes O(1) rows.

## Design

### 1. A rollup: `page_content_edited_at` (page/editor, server)

A `derived-tables` rollup (`defineRollup`, the documented home for "a per-parent
aggregate a hot collection joins"):

- table `page_content_edited_at(page_id text pk, edited_at timestamptz not null)`,
  an `IMPERATIVE_PUBLIC_TABLES` entry, contributed via `DerivedTable(...)` from the
  editor server barrel.
- `select`: `SELECT b.page_id, max(b.updated_at) FROM page_blocks b
   WHERE b.deleted_at IS NULL AND b.page_id IS NOT NULL AND scope(b.page_id)
   GROUP BY b.page_id`.
- one source: `page_blocks`, `carry: pageId`, `reads: [updatedAt, deletedAt]`.

Only CONTENT is rolled up (rows whose nearest page is P); the page's own row is
not, so the single-carry rollup suffices — no multi-carry extension needed. A
write to a block whose `page_id`, `updated_at` or `deleted_at` did not move
(e.g. a `doc_rank` re-mint, an `expanded` flag) re-aggregates nothing (the
maintain function's diff). A block moving pages re-aggregates both keys.

Cost per typing write: one trigger aggregate over that page's blocks via
`page_blocks_page_id_idx` (bounded by the page, never by the number of pages or
blocks overall), plus a guarded upsert of one row.

### 2. `editedAt` on `PageRowSchema` / `pagesTree`

`pageRowsServeOptions` (`page-rows.ts`) gains a rollup join (`on: _blocks.id`,
the query-resource rollup-join form `task-rows.ts` uses) and an `editedAt` field
= `greatest(page_blocks.updated_at, rollup.edited_at)` (an `expr`; a page with no
content has no rollup row → its own `updated_at`). Spelled ONCE as an exported
helper so `readPageEditedAt` uses the same expression.

Routing: a content write moves one rollup row → that page row's refill (one row,
O(1) loader). The page row's own writes are refills as today. Update the
`page-rows.ts` / `core/resources.ts` comments ("a write to a content block loads
nothing" becomes "loads its page's one row") and the `pages-tree-oracle` test.

### 3. One definition, three readers

- `readPageEditedAt` reads the page row joined to the rollup with the shared
  expression (markdown-apply `<page-meta>` keeps calling it).
- The `pageEditedAt` live value and its `serveValue` are DELETED; the header
  "Edited" label (`pages/history/.../edited-history-action.tsx`) reads
  `useLiveRow(pagesTree, pageId).editedAt`. Header, sidebar and Welcome now read
  the same field of the same row — they cannot disagree.
- Sidebar: field `updatedAt` → `editedAt` (label "Edited"), config `fieldId`s
  updated (sort + `is-within-past` filter).
- Welcome Recent pages: sort by and display `editedAt`.
- Any optimistic `PageRow` constructor (e.g. page create) supplies `editedAt`.

## Verification

- `./equin test plugins/page/plugins/editor` (oracle + a new rollup test:
  content edit moves `editedAt`, trash of the newest block moves it back, page-row
  rename moves it, move-between-pages updates both).
- `./equin build` (installs the rollup, checks).
- In the deployed app: edit a page's body, see it rise to the top of sidebar Recent
  and Welcome Recent, with the same time as its header "Edited" label
  (screenshot.ts).
