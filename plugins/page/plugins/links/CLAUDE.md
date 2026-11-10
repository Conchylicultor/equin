# links

## Backlinks are a value per target page, computed from what it follows

`pageBacklinks` (`core/resources.ts`) is a `liveValue` with `params: ["pageId"]`,
served on the db arm (`server/internal/resources.ts`). Not a `liveCollection`:
its rows are a join of a few followed reads, not the rows of one table.

It declares NO whole-table read. Everything it reads is a FOLLOW
(network/live's `follows`, built at the bind with `followsAtBind`), so a
write reaches a tuple only when it touches a row that tuple read, and the
loader makes no query of its own (the drift guard holds it to that):

- `edges` — the target's FIRST edges, one per linking page
  (`pageBacklinkEdges`, `page-links.first-edges`: a scoped `all` by
  `targetPageId` over `page_links`, `first` as the base membership);
- `target` — the target page's own row (the title a snippet splits around);
- `sources` — each linking page's row (title, icon) and its first linking
  block (the snippet's text), by id;
- `up:1` … `up:8` — the ancestor pages above the linking pages, one dependent
  follow per level (`BACKLINK_PATH_LEVELS`: a walk of unknown depth has no
  spelling as follows; a path deeper than that starts with `…`, and the list
  truncates paths from their lead anyway);
- `referent:<i>` — the rows the chips in the linking text name, one follow per
  chip family (inline-chip's `inlineTokenReferentFollows`), none when the text
  holds no chip of that family.

Every block read goes through the editor's `blockContents`
(`page.block-contents`, lookup-only `{ id, pageId, type, data }`, matched by
id). So typing in any block a tuple does not name — the ~1s `data.text`
projection — reaches no tuple; typing in a linking block recomputes it (its
snippet may move); a rename of a linking page, an ancestor or a chip's
referent recomputes exactly the tuples naming it; a write to another target's
edges, or a second linking block's, reaches nothing. Before (2026-11-08) the
value read `page_links`, `page_blocks` and every chip family's tables whole:
each keystroke anywhere — and every task / conversation write — recomputed
every subscribed tuple and pushed the same bytes (~1.3 no-op pushes/s on main
while typing). `e2e/backlinks-typing-reach.ts` measures it on a build.

## An edge names the block that links

`page_links` is one row per (source page, target page, **linking block**):
`reindexPage` records which block each extraction came from, so the same page
linking from three paragraphs is three rows, and it marks the FIRST of them in
document order (`first`, computed from the page's forest the reindexer reads
anyway — `inDocumentOrder`; written only when which block comes first moves).
The backlinks value follows only the `first` edges, so it never reads a source
page's forest; `pageLinkTargets` (one row per page, read by id) aggregates the
DISTINCT target pages of all edges. `page_links` is an entity
(`defineEntity(pageLinksEntityRef)`), so a collection can be served from it.

That block is what the row's **snippet** is read from: its plain text
(`textOf`), with every inline token a chip family resolves shown as its title
(`inlineTokensAsLiveText`, `text-editor/inline-chip`, from the followed
referent rows), split around the target's title and trimmed to ~80 characters
(`server/internal/snippet.ts`). `null` when the block IS the link — a
page-link block has no text — so the row is its title line alone. The
extractor API knows nothing of snippets: whatever extractor matched a block,
the snippet is derived from the block's text.

Each row also carries its source page's `path` — the ancestor pages' titles,
root first, read off the `up:<n>` follows — so the list can say where the
linking page sits without its web half reading the whole page tree
(`pagesTree`).

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

- **`linkRanks`** — target → the `doc_rank` of the FIRST placed block linking
  there (a link-to-page block: the editor's `pageTreePlace`), a second
  aggregate of the same join, nesting the editor's `page_tree_rank` rollup on
  `source_block_id`. The sidebar hands it to `treeAliases({ rank })`, so a
  link alias is drawn where the link is written among the sub-pages; a
  target linked only inline has no entry (drawn after the sub-pages). A
  re-mint of a placed block re-aggregates its page's row; it is refilled
  only when the stored map changed.
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
live-page predicate: the backlinks value reads its source through
`blockContents` (live blocks only — a trashed source reads not found), and
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
    - `resource.declare` "page-links.first-edges"
    - `resource.declare` "page-links.first-edges:rows"
    - `resource.declare` "page-links.targets:rows"
    - `derived-table` "page_link_targets"
    - `trigger` "page.links.reindex"
    - `page.editor.block.onDelete`
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `page/editor` ×10
    - `network/live` ×3
    - `database` ×2
    - `infra/events` ×2
    - `primitives/text-editor/inline-chip` ×2
    - `database/derived-tables.DerivedTable`
    - `database/sql-projection.parsed`
    - `infra/entities.defineEntity`
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
    - `page-links.first-edges` (keyed)
    - `page-links.first-edges:rows` (keyed, point)
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
    - `fields/bool/config.boolField`
    - `fields/json/config.jsonField`
    - `fields/string-list/config.stringListField`
    - `fields/text/config.textField`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
    - `network/live.liveValue`
    - `network/live/query-resource.compositeKey`
    - `packages/list-bound.wholeList`
    - `packages/list-bound.wholeRecord`
    - `page/block-entity.pagesEntityRef`
    - `ui/icons/emoji.EmojiSchema`
  - Exports (types):
    - `BacklinkRow`
    - `BacklinkSnippet`
    - `PageLinkTargetsRow`
  - Exports (values):
    - `BacklinkRowSchema`
    - `LinkRanksSchema`
    - `pageBacklinkEdges`
    - `pageBacklinks`
    - `pageLinksEntityRef`
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
