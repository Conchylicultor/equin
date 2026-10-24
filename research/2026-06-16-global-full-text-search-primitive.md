# Global full-text search — reusable primitive + Pages quick-find

## Context

The Pages sidebar can filter the page tree by **title** only (client-side `filterTree`
over `pageData(block).title`). There is no way to find a page by its **body content**.
Users want a "quick-find" that searches across all block text and jumps to the matching page.

Rather than bolt a one-off search onto Pages, we build a **reusable, cross-app
full-text search primitive** (indexed Postgres FTS) and make Pages its first consumer.
Any future app (tasks, story, file-explorer, …) can index its entities into the same
engine and drop in the same quick-find dialog with one `onSelect` callback.

**Decisions locked with the user:**
- **Trigger:** a "Search" button in the Pages sidebar — *no keyboard shortcut*, no command-palette entry.
- **Matching:** indexed **word + prefix** full-text search (Postgres `tsvector` GIN), with
  relevance ranking and highlighted snippets (`ts_headline`). Typing `brow` matches `brown`.

## Architecture (3 layers)

Both reusable layers live under a new top-level **`plugins/search/` umbrella** (a pure
container — `package.json` + `CLAUDE.md` + `plugins/`, no runtime barrels, like `infra`/`primitives`):

```
Layer 1  search/plugins/engine      — substrate: search_documents table + index API + GET /api/search
Layer 2  search/plugins/quick-find  — UI: useSearch() hook + <QuickFindDialog> (navigation injected)
Layer 3  apps/pages/plugins/content-search — consumer: "pages" source reindex + sidebar Search button
```

The substrate is **domain-agnostic**: a "search document" is one navigable entity
(`{ source, entityId, title, body, route, metadata }`). The engine never knows about
blocks or pages. Each consumer owns *what* it indexes and *when* (bound to its own change
event), and *how to navigate* on select. This mirrors the established `page/links` pattern:
a derived index kept in sync by a reindex job bound to `page.blocksChanged` — the editor
plugin and its write handlers stay **untouched**.

---

## Layer 1 — `search/plugins/engine` (substrate)

The indexed-search engine: owns the table + index API + endpoint. Cross-plugin consumers
use only its barrels (`@plugins/search/plugins/engine/{core,server}`).

### `core/`
- `endpoints.ts` — `searchEndpoint = defineEndpoint({ route: "GET /api/search", query: z.object({ q: z.string().min(1).max(200), sources: z.string().optional() }), response: z.array(SearchResultSchema) })`.
- `schemas.ts` — `SearchResultSchema = z.object({ source, entityId, title, snippet, route, metadata: z.record(z.unknown()).nullable() })` and `SearchDocSchema` (the upsert shape).
- `index.ts` — barrel exporting the endpoint, schemas, and inferred types (`SearchResult`, `SearchDoc`).

### `server/`
- `internal/tables.ts` — new table `search_documents`:
  - `source text notNull`, `entityId text notNull` → **composite PK** `(source, entityId)`.
  - `title text notNull default ''`, `body text notNull default ''`, `route text notNull`,
    `metadata jsonb notNull default '{}'`.
  - generated tsvector column `tsv`:
    `setweight(to_tsvector('english', coalesce(title,'')), 'A') || setweight(to_tsvector('english', coalesce(body,'')), 'B')`
    via drizzle `.generatedAlwaysAs(sql\`…\`)` (title weighted above body).
  - **GIN index** on `tsv`. Index on `source` for source-scoped queries.
- `internal/index-api.ts` — generic upsert/delete helpers consumers call from their reindex jobs:
  - `upsertSearchDocs(docs: SearchDoc[])` — `insert … onConflictDoUpdate` on `(source, entityId)`.
  - `deleteSearchDocs(source, entityIds[])`.
  - `deleteSource(source)` — wipe a source (used by full backfills).
- `internal/build-tsquery.ts` — `buildPrefixTsQuery(q): string`. Sanitizes input (split on
  whitespace, strip chars outside `[\w]`, drop empties), joins terms with ` & `, appends `:*`
  to each term → fed to `to_tsquery('english', …)`. This is what gives **word + prefix**
  type-ahead matching while staying injection-safe. Returns `null` for empty input.
- `internal/handle-search.ts` — `implement(searchEndpoint, …)`:
  ```sql
  SELECT source, entity_id, title, route, metadata,
         ts_headline('english', body, query,
           'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=12,MinWords=4') AS snippet,
         ts_rank(tsv, query) AS rank
  FROM search_documents, to_tsquery('english', :tsq) query
  WHERE tsv @@ query [AND source = ANY(:sources)]
  ORDER BY rank DESC
  LIMIT 30
  ```
  Returns `[]` when `buildPrefixTsQuery` yields null. Snippet falls back to the title when
  the match is title-only (empty `ts_headline`).
- `index.ts` — barrel exporting `upsertSearchDocs`, `deleteSearchDocs`, `deleteSource`, and the
  `httpRoutes` registration `{ [searchEndpoint.route]: handleSearch }`.

---

## Layer 2 — `search/plugins/quick-find` (reusable UI)

Pure client primitive; depends only on the engine's **core** (endpoint def) + ui-kit.
Navigation is **injected**, so the primitive has no `apps`/route dependency (correct layering).
(Named `quick-find` to avoid collision with the existing `primitives/search`, which is
in-memory text filtering — a different thing.)

### `web/`
- `internal/use-search.ts` — `useSearch(q, { sources?, enabled? })` wraps
  `useEndpoint(searchEndpoint, {}, { query: { q, sources }, enabled: q.length > 0 })` with a
  debounce (~150ms) on `q`.
- `components/quick-find-dialog.tsx` — `<QuickFindDialog>`:
  - Props: `open`, `onOpenChange`, `sources?: string[]`, `placeholder?`,
    `onSelect: (r: SearchResult) => void`, `renderIcon?: (r: SearchResult) => ReactNode`.
  - shadcn `Dialog`/`DialogContent` (from `ui-kit`) + `SearchInput` (from `primitives/search`),
    auto-focused. Debounced query → `useSearch`.
  - States: `<Loading variant="rows" />`, `<Placeholder>` empty/no-results.
  - Result rows via the `Row` primitive: optional `renderIcon(r)`, title, and the **snippet**
    with `<mark>` highlight. Snippet is parsed server-side `<mark>` tags into structured
    `{ text, highlight }[]` segments (no `dangerouslySetInnerHTML`) — add a small
    `parseHighlightedSnippet()` util in this plugin; highlighted segments render with
    `bg-[highlight token] font-medium`.
  - Keyboard nav: ArrowUp/Down move selection, Enter fires `onSelect`, Esc closes.
- `index.ts` — barrel exporting `QuickFindDialog` and `useSearch`.

> Future extension (not built now): a client `SearchSource.Register` slot carrying per-source
> `onSelect`/`renderIcon` would let a single global quick-find search every source at once.
> The injected-`onSelect` contract is forward-compatible with that.

---

## Layer 3 — `apps/pages/plugins/content-search` (Pages consumer)

Thin. Indexes pages into the substrate and renders the dialog. Imports `_blocks`,
`blocksChanged`, `BlockLifecycle`, `PAGE_BLOCK_TYPE`, `pageData`, `textOf`/`plainOf` from
`@plugins/page/plugins/editor/{server,core}` (cross-plugin via barrels — same as `links`).

### `server/`
- `internal/reindex-page.ts` — `reindexPageSearch(pageId)`:
  - Load the page block + all blocks where `pageId = :pageId`.
  - If the page block is gone → `deleteSearchDocs("pages", [pageId])` and return.
  - `title = pageData(pageBlock).title`; `body =` join of `textOf(b)` over content blocks;
    `route = "/pages/page/" + pageId`; `metadata = { iconSvgNodes }`.
  - `upsertSearchDocs([{ source: "pages", entityId: pageId, title, body, route, metadata }])`.
- `internal/reindex-job.ts` — `defineJob({ name: "pages.search.reindex", event: z.object({ pageId }), dedup: "none", run: ({ event }) => reindexPageSearch(event.pageId) })` — idempotent (diff-free upsert), mirrors `reindexLinksJob`.
- `internal/backfill-job.ts` — `defineJob` oneShot boot job: enumerate every `type="page"` block and call `reindexPageSearch` (seeds existing data on first deploy).
- `internal/delete-hook.ts` — `BlockLifecycle.BeforeDelete` hook: for deleted `type="page"`
  blocks, `deleteSearchDocs("pages", [id])` (FK cascade wipes `page_blocks` without firing the
  reindexer — same reason `links` needs its delete hook).
- `index.ts` — `register: [reindexJob, backfillJob]`, `contributions: [Trigger({ on: blocksChanged, do: reindexJob, with: {}, oneShot: false }), BlockLifecycle.BeforeDelete(deletePagesSearchHook)]`.

### `web/`
- `components/pages-search.tsx` — a "Search" trigger row (icon + "Search" label, `Row` primitive)
  that opens `<QuickFindDialog sources={["pages"]} onSelect={r => { openPane(pageDetailPane, { pageId: r.entityId }, { mode: "push" }); }} renderIcon={r => <PageIcon nodes={r.metadata?.iconSvgNodes} className="size-4" />} />`.
- `index.ts` — contributes the trigger into the **`Pages.Sidebar`** slot (a second contribution
  above the existing page tree; no edit to `page-tree`'s `PagesSidebar`). Confirm the
  `Pages.Sidebar` slot signature in `apps/pages/plugins/shell/web` during implementation; if it
  is single-host, instead add the button inside `page-tree`'s `SidebarPaneSection` header.

### `package.json`
Standard plugin package `@singularity/plugin-apps-pages-content-search`.

---

## Files

**New — `search/` umbrella**
| File | Purpose |
|---|---|
| `plugins/search/package.json` | umbrella container (`@singularity/plugin-search`) |

**New — Layer 1 (`plugins/search/plugins/engine/`)**
| File | Purpose |
|---|---|
| `core/index.ts`, `core/endpoints.ts`, `core/schemas.ts` | endpoint + result/doc schemas |
| `server/index.ts` | barrel: index API exports + `/api/search` route |
| `server/internal/tables.ts` | `search_documents` table + tsvector GIN |
| `server/internal/index-api.ts` | `upsertSearchDocs` / `deleteSearchDocs` / `deleteSource` |
| `server/internal/build-tsquery.ts` | prefix-aware, injection-safe tsquery builder |
| `server/internal/handle-search.ts` | ranked search + `ts_headline` snippets |
| `package.json` | |

**New — Layer 2 (`plugins/search/plugins/quick-find/`)**
| File | Purpose |
|---|---|
| `web/index.ts` | barrel: `QuickFindDialog`, `useSearch` |
| `web/internal/use-search.ts` | debounced search hook |
| `web/components/quick-find-dialog.tsx` | the dialog UI + snippet highlight |
| `package.json` | |

**New — Layer 3 (`plugins/apps/plugins/pages/plugins/content-search/`)**
| File | Purpose |
|---|---|
| `server/index.ts` | register jobs + trigger + delete hook |
| `server/internal/reindex-page.ts` | derive + upsert one page's search doc |
| `server/internal/reindex-job.ts` | job bound to `blocksChanged` |
| `server/internal/backfill-job.ts` | one-shot boot backfill |
| `server/internal/delete-hook.ts` | remove docs on page delete |
| `web/index.ts` | contribute Search button into `Pages.Sidebar` |
| `web/components/pages-search.tsx` | trigger row + `QuickFindDialog` wiring |
| `package.json` | |

**Modified:** none in `page/editor` — the substrate is fully additive. (Only the autogenerated
registries/docs change, via `./equin build`.)

---

## Reuse / precedent
- Index sync mirrors `plugins/page/plugins/links` exactly: `reindexPage` + `reindexLinksJob`
  (`Trigger({ on: blocksChanged … })`) + `BlockLifecycle.BeforeDelete` cleanup hook.
- Plain-text extraction reuses existing `textOf(node)` / `plainOf(value)` from
  `@plugins/page/plugins/editor/core` — no new parsing.
- Endpoint/handler/hook follow the standard `defineEndpoint` → `implement` → `useEndpoint`
  triad (e.g. `handle-list-pages.ts`).
- UI composes `ui-kit` Dialog, `primitives/search` `SearchInput`, `Row`, `Loading`,
  `Placeholder`, `PageIcon`.

## Plugin-boundary notes
- One barrel per runtime; cross-plugin imports only via `@plugins/<…>/{core,server,web}`.
- Layering is acyclic: `search/quick-find` (web) → `search/engine/core`; `content-search` →
  `search/engine/{server,core}` + `search/quick-find/web` + `page/editor/{server,core}` +
  `apps/pages/page-tree/web` (for `pageDetailPane`) + `apps/pages/shell/web` (for `Pages.Sidebar`).
  The engine depends on nothing app-specific.
- New plugins are discovered from the filesystem; `./equin build` regenerates the
  registries and docs (`plugins-doc-in-sync` / `plugins-registry-in-sync`).

## Verification
1. `./equin build` — generates the `search_documents` migration cleanly; no type errors.
   Then `./equin check` (boundaries, registry/doc-in-sync).
2. Server boot runs the backfill job; via MCP `query_db`:
   `SELECT count(*) FROM search_documents WHERE source='pages'` matches the page count, and
   `EXPLAIN SELECT … WHERE tsv @@ to_tsquery(...)` shows a **Bitmap Index Scan** on the GIN
   index (not Seq Scan).
3. Open `http://<worktree>.localhost:9000/pages` → sidebar shows a **Search** button.
4. Scripted Playwright run (`e2e/screenshot.mjs --click "Search"`): dialog opens, type a word
   known to be in a page **body** → result appears with the right page title + highlighted
   snippet; click → page opens (`pageDetailPane`).
5. Type a partial word (`brow` for `brown`) → prefix match works. Type a word only in a page
   **title** → that page surfaces.
6. Edit a page, add a unique test word, save → re-search finds it within a beat (reindex job
   fired by `blocksChanged`). Delete a page → it disappears from results (delete hook).
```
```
