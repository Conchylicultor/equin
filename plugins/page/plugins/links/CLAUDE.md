# links

## Backlinks are a value per target page

`pageBacklinks` (`core/resources.ts`) is a `liveValue` with `params: ["pageId"]`,
served on the db arm with `unbounded: { reason }`. Not a `liveCollection`: its
rows are a join (`page_links` ⨝ the live `page` blocks, title and icon projected
out of `data`), and the edge table's key is the composite (source, target,
block) triple. Nothing notifies it — the loader's read-set recomputes it on any
edge write or source-page edit.

## An edge names the block that links

`page_links` is one row per (source page, target page, **linking block**):
`reindexPage` records which block each extraction came from, so the same page
linking from three paragraphs is three rows. The backlinks loader folds them
back to one row per source page — its FIRST linking block in document order
(`inDocumentOrder`; a page's block forest is read only when it links from more
than one block) — and `pageLinkTargets` (one row per page, read by id)
aggregates the DISTINCT target pages of its edges.

That block is what the row's **snippet** is read from: its plain text
(`textOf`), with every inline token a chip family resolves shown as its title
(`inlineTokensAsText`, `text-editor/inline-chip`), split around the target's
title and trimmed to ~80 characters (`server/internal/snippet.ts`). `null` when
the block IS the link — a page-link block has no text — so the row is its title
line alone. The extractor API knows nothing of snippets: whatever extractor
matched a block, the snippet is derived from the block's text.

Each row also carries its source page's `path` — the ancestor pages' titles,
root first, walked up the `pageId` relation one batched query per tree level —
so the list can say where the linking page sits without its web half reading
the whole page tree (`pagesTree`).

## The page-pair graph, read by id (`pageLinkTargets`)

`liveCollection("page-links.targets", { from: pagesEntityRef, id })` —
LOOKUP-ONLY: a live page as `{ id, linksTo }`, the distinct pages it links to,
a self-link excluded, `[]` when it links nowhere. No whole set: the Pages
sidebar declares it as its live tree's `aliases` (data-view
`treeAliases({ collection, targets })`), and the tree reads it by id for the
rows its windows hold — one `{ ids }` read per loaded level, in chunks of the
collection's `maxIds` — drawing each target as a reference child. What the
sidebar holds is bounded by its windows, never by how many pages or links
exist.

Served by `serveCollection` over the `page_blocks` TABLE
(`server/internal/link-target-rows.ts`, the ONE spelling the server and the
tests compile): `where type = 'page' AND deleted_at IS NULL`, `linksTo` a
MATERIALIZED children join (`materializeJoin`) over `page_links` on
`source_page_id` (`array_agg(DISTINCT target_page_id ORDER BY target_page_id)`,
`ifNone` an empty array), stored in the derived rollup `page_link_targets`
(`DerivedTable`, on the change feed). Materialized because an unmaterialized
grouped join is `all`-only, and this is read by id. It keeps only the edges
into a LIVE page: the join nests the editor's `pageLive` rollup on
`target_page_id` (below).

- **One row per SOURCE page**: a `page_links` write — the reindexer's diff,
  an FK cascade — or a target's trash / restore (a `page_live` write, routed
  to every page linking there) re-aggregates its source's stored
  list, and a reader holding that page refills it only when the list changed
  (a second linking block of one pair loads nothing). The base route reads
  only `id`, `type` and `deleted_at`, so the `data.text` typing projection, a
  rename or a `doc_rank` re-mint reach nothing; a trashed page reads not
  found.
- **The key is new** (it was `page-links.sources`, the whole set of every page
  with its linking pages, and before it the legacy push resource
  `page-links`), so a tab still running an old bundle is refused
  `unknown-key` — the skew/Reload prompt. Costs, parity with the old DISTINCT
  loader and C39 are pinned by `server/internal/link-targets-oracle.test.ts`
  on the tree oracle.
- Not folded into `pagesTree`'s row: `links/server` imports `editor/server`, so
  the editor joining `page_links` would be an import cycle.

## An edge outlives its pages' trash

An edge is derived from its SOURCE page's content alone: A's content links to
B whatever B's state, so trash and restore write no edge (there is no trash or
restore hook; only a purge's FK cascade removes edges). `reindexPage` keeps an
edge to a trashed target (`existingPageIds`, the editor's trash-aware
existence read) and does nothing for a trashed source (its content is frozen
with it). Liveness is the READERS' filter, through the editor's one
live-page predicate: the backlinks reads join the source to `liveBlocks`, and
`pageLinkTargets` nests `pageLive` (a rollup of `livePageSql`) on the target.
So a restore brings every edge back at once, with no reindex — the sidebar's
alias to B, A's backlink on B's page — and a trashed B leaves no dangling
alias chevron on A.

`page_links` is derived state, so a shape change rebuilds rather than migrates
it: the `page.links.backfill` boot warm-up reindexes every page (diff-based, so
a steady-state reboot writes nothing).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Backlinks index for cross-page links: page_links edge table, extractor registry, reindex, backlinks resource. Backlinks index for cross-page links: page_links edge table, extractor registry, reindex, backlinks resource, and the boot backfill (a warm-up enqueuing a job that reindexes every live page's outgoing links, off the serving-critical boot path).
- Server:
  - Contributes:
    - `resource.declare` "page-backlinks"
    - `resource.declare` "page-links.targets:rows"
    - `derived-table` "page_link_targets"
    - `trigger` "page.links.reindex"
    - `page.editor.block.onDelete`
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `page/editor` ×8
    - `database/sql-projection` ×2
    - `database` ×2
    - `infra/events` ×2
    - `network/live` ×2
    - `primitives/text-editor/inline-chip` ×2
    - `database/derived-tables.DerivedTable`
    - `infra/jobs.defineJob`
    - `infra/warmup.defineWarmup`
    - `network/live/query-resource.materializeJoin`
  - DB schema:
    - `plugins/page/plugins/links/server/internal/rollup-table.ts`
    - `plugins/page/plugins/links/server/internal/tables.ts`
  - Exports (types):
    - `BacklinkSource`
    - `PageLinkExtractor`
  - Exports (values):
    - `loadBacklinkSources`
    - `PageLinks`
    - `reindexPage`
  - Register:
    - `defineJob('page.links.reindex')`
    - `defineJob('page.links.backfill')`
    - `defineWarmup('page.links.backfill')`
  - Resources:
    - `page-backlinks` (push, whole: the pages that link to one page — a join over page_links and the live page blocks, not the rows of one table, whole: one page's ancestors — as deep as the page tree nests)
    - `page-links.targets:rows` (keyed, point)
- Web:
  - Uses:
    - `network/live.useLive`
    - `network/live/live-state.ResourceErrorInline`
    - `page/editor.PageIcon`
    - `page/page-reference.PageReferenceTrailing`
    - `page/page-reference.usePageNavigation`
    - `primitives/css/center.Center`
    - `primitives/css/clip.clipClasses`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/data-view.DataView`
    - `primitives/data-view.defineDataView`
    - `primitives/data-view.FieldDef`
  - Exports (types): `BacklinksProps`
  - Exports (values): `Backlinks`
- Core:
  - Uses:
    - `fields/string-list/config.stringListField`
    - `network/live.liveCollection`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
    - `page/block-entity.pagesEntityRef`
    - `ui/icons/emoji.EmojiSchema`
  - Exports (types):
    - `BacklinkRow`
    - `BacklinkSnippet`
    - `PageLinkTargetsRow`
  - Exports (values):
    - `BacklinkRowSchema`
    - `pageBacklinks`
    - `pageLinkTargets`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-medium`
  - Imported by:
    - `apps/pages/page-tree`
    - `page/inline-page-link`
    - `page/markdown-apply`
    - `page/page-link`

<!-- AUTOGENERATED:END -->
