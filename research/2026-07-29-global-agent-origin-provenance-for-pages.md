# Agent-origin provenance for pages

Date: 2026-07-29 · Category: global (e2e-harness + page/editor + apps/pages + config)

## Context

Seven junk pages accumulated in the **main (`singularity`) production DB** on 2026-07-28 —
`alphab` / `ravoc` / `harlie`, `/callout`, `version one alpha content post-restore` — mixed
into the user's real Pages sidebar. Each one's `created_at` lands 2–4s after an agent Bash
call in the transcripts, e.g.:

```
bun plugins/page/plugins/editor/e2e/copy-paste-verify.ts --base http://singularity.localhost:9000
git show HEAD:…/crdt-restore-verify.ts > zz-tmp-old-restore.ts && bun … --base http://singularity.localhost:9000
bun plugins/page/plugins/editor/e2e/slash-repro.ts --base http://singularity.localhost:9000
```

Two independent causes:

1. **Agents point e2e at main deliberately.** The harness default is already safe —
   `target.ts:38` derives the base from `basename(REPO_ROOT)`, so a bare run hits the agent's
   own worktree. Nobody hit main by accident. They typed `--base http://singularity.localhost:9000`
   to get a *control* run on unmodified code ("Main is deployed without my changes, so it's a
   free control"), because rebuilding or stashing costs 20+ minutes, and — for a
   user-reported bug — main is the *only* place the bug exists. **This is a legitimate need
   and the plan does not take it away.**
2. **Nothing ever deletes the page.** `openBlankPage`
   (`plugins/page/plugins/editor/e2e/support/blank-page.ts:81`) clicks "Blank page" and
   returns; `withBrowser` only closes the browser. Every run of any of the ~14 scripts using
   it leaks a page. Invisible in a worktree (forked DB, thrown away) — but worktree DBs are
   forked *from* main, so each leaked prod page is inherited by every future worktree forever.

**Intended outcome:** pages written by an automated session are *marked*, visually
*segregated* into an `[Agent]` section of the Pages sidebar tree, and *self-expiring*. A
control run against main becomes harmless instead of forbidden.

### Explicitly not doing

- **No teardown.** Per-script cleanup is best-effort (never runs on SIGKILL / Playwright
  timeout / Ctrl-C — the normal ways these runs end) and it destroys the failure evidence an
  agent needs. The sweeper covers it, and covers it on the paths teardown can't reach.
- **No AsyncLocalStorage origin primitive.** Initially sketched, then dropped: `implement()`
  already hands every handler the raw `Request` (`endpoints/core/implement.ts:36-41`), and
  the one write path that needs the signal is at the HTTP boundary. Introduce the ALS
  primitive only if a second consumer appears that genuinely can't see `req`.

## Design

Four pieces. The concept is **provenance** (`origin: user | agent`), not "is a test page" —
so tasks/conversations can adopt the same signal later without a second mechanism.

### 1. The signal — one line in the e2e harness

`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/browser.ts:50-56`, in
`withBrowser`'s `session()`:

```ts
const context = await browser.newContext({
  viewport: …,
  colorScheme: …,
  extraHTTPHeaders: {
    "x-singularity-origin": "agent",
    "x-singularity-origin-source": originSource(), // e.g. "e2e:copy-paste-verify"
  },
});
```

`originSource()` derives from `basename(process.argv[1])` — no per-script argument.

This is the load-bearing property: **one edit marks all ~14 existing scripts, every future
script, and ad-hoc `screenshot.ts --click` drives**, with nothing to opt into and nothing to
remember. Playwright's `extraHTTPHeaders` applies to every request the context issues,
including the SPA's `fetch` calls, so it covers pages created by clicking "Blank page".

Known limit, stated rather than papered over: an agent hitting the API with raw `curl` is not
marked. Acceptable — the harness is the overwhelmingly dominant path.

### 2. The marker — a new `BlockLifecycle.AfterCreate` hook + a side-table

**Why a hook and not an inline stamp:** the marker plugin must import `_blocks` from
`@plugins/page/plugins/editor/server`, so stamping *inside* `handleCreateBlock` would make
the editor import the marker plugin back — a cycle, banned by the boundary checker. The
editor must dispatch generically and never name the contributor.

**a. Add the create hook** in `plugins/page/plugins/editor/server/internal/document-hooks.ts`,
mirroring the existing `BlockDeleteHook` / `BlockTrashHook` shape byte-for-byte:

```ts
// A block row was just inserted. `req` is the request that caused the create, so a
// contributor can classify its provenance; the handler never inspects it itself.
export interface BlockCreateHook {
  afterCreate: (
    block: { id: string; type: string; parentId: string | null; pageId: string | null },
    req: Request,
  ) => Promise<void> | void;
}

export const BlockLifecycle = {
  AfterCreate: defineServerContribution<BlockCreateHook>("page.editor.block.afterCreate"),
  BeforeDelete: …, OnTrash: …, OnRestore: …,
};
```

Dispatched from `handle-create-block.ts:12` (change the handler to destructure `{ body, req }`)
after the insert + `notifyBlockChange`, iterating `getContributions()` — the same generic loop
`runBeforeDelete` uses (`trash-blocks.ts:41-62`).

**b. New plugin `plugins/apps/plugins/pages/plugins/agent-origin/`**, copying `starred`
(`plugins/apps/plugins/pages/plugins/starred/`) as the structural precedent:

```ts
// server/internal/tables.ts
export const pageBlocksOrigin = defineExtension(_blocks, "origin", {
  source: text("source").notNull(),          // "e2e:copy-paste-verify"
}, {
  indexes: (t, b) => [b.index("created_at").on(t.createdAt)],  // the sweep's scan
});
export const _pageBlocksOriginExt = pageBlocksOrigin.table;    // drizzle-kit discovery
```

`defineExtension` supplies `parentId` (PK + FK `onDelete: cascade`), `createdAt`, `updatedAt`
automatically (`entity-extensions/server/internal/define-extension.ts:29-37`); the `indexes`
option is the one added in `ff5627218` (`entity-extensions/CLAUDE.md:41-54`).

**c. The contribution** — `server/internal/create-hook.ts` implements `afterCreate`: when
`req.headers.get("x-singularity-origin") === "agent"` **and** `block.type === PAGE_BLOCK_TYPE`
(`editor/core/schemas.ts:69`), `await pageBlocksOrigin.upsert(block.id, { source })`.

Stamp **every** agent-created page, root or nested — the tree's own root-inheritance (§3)
handles display, and an honest per-row marker keeps the sweep simple.

Note `createPageWithSeed` issues **two** `POST /api/blocks` calls per "Blank page" click (the
page row, then one seed text block); only the first is `type: "page"`, so exactly one marker
row is minted per page.

### 3. The `[Agent]` section — a contributed field + a config-authored `groupBy`

**a. Live resource.** `windowQueryResource`, **not** the `queryResource` that `starred` uses:
CLAUDE.md requires new DB-backed collection resources to be membership-bounded, and
`queryResource` is explicitly legacy-pending-migration. Copy
`plugins/shell/plugins/notifications/server/internal/resources.ts:17` as the shape:

```ts
// shared/resources.ts
export const agentPagesResource = windowQueryResourceDescriptor<AgentPageRow>(
  "pages-origin", AgentPageRowSchema, (r) => r.parentId, { defaultLimit: 200 },
);
// server/internal/resource.ts
export const agentPagesServerResource = windowQueryResource(agentPagesDescriptor, {
  from: _pageBlocksOriginExt,
  select: { parentId: …parentId, source: …source, createdAt: …createdAt },
  window: { order: [{ key: …createdAt, dir: "desc" }] },
});
```

A 24h TTL keeps the live set in single digits, so a 200-row window is never the binding
constraint.

**b. The field**, `web/components/origin-field.tsx`, copying `starred-field.tsx:20-51`:

```tsx
export function OriginField({ render }: FieldExtensionProps<PageRow>) {
  const result = useResource(agentPagesResource);
  const agentIds = useMemo(() => …new Set(result.data.map((r) => r.parentId)), [result]);
  const fields = useMemo<FieldDef<PageRow>[]>(() => [{
    id: "origin", label: "Origin", type: "enum",
    options: [{ value: "user", label: "Mine" }, { value: "agent", label: "Agent" }],
    value: (b) => (agentIds.has(b.id) ? "agent" : "user"),
    // groupable defaults TRUE for enum (use-data-view-sections.ts:21-25) — left on, unlike
    // `starred`, which opts out. That is the whole point here; see the trade-off below.
  }], [agentIds]);
  return <>{render(fields)}</>;
}
```

Registered via `PageTree.Fields({ id: "origin", component: OriginField })`
(`page-tree/web/slots.ts:44`), which the sidebar already consumes through
`fieldExtensions={PageTree.Fields}` (`pages-sidebar.tsx:152`). **No change to `pages-sidebar.tsx`.**

Unmarked rows project `"user"` rather than `null`, so there is no "None" bucket and the
section order follows `options` order: **Mine**, then **Agent**.

**c. Turn grouping on by default** — `config/apps/pages/page-tree/pages-sidebar.jsonc`, the
existing `views` array (config is the only way view instances are defined; `<DataView>` has no
`defaultGroupBy` prop):

```jsonc
{ "id": "pages", "name": "Pages",
  "view": { "type": "tree", "visibleFields": ["title"], "groupBy": "origin" } },
```

`visibleFields: ["title"]` stays as-is, keeping `origin` a pure group/filter dimension rather
than a chip rendered on every row (the same reasoning the file already records for `starred`).

**Why grouping actually works here:** the tree partitions **roots only** and every descendant
follows its root's section (`tree-view.tsx:290-316` → `bucketRowsByRootSection` in
`internal/group-rows.ts:51-104`). A subtree is never split. Agent pages are created as roots
(`parentId: null`) in every e2e flow, so they land in the `Agent` section with their whole
subtree beneath them.

### 4. The sweeper

`defineRetention` **can** do this — via its `beforeDelete` seam, which is exactly how the trash
plugin drives `purgeTrashedPages` (`infra/plugins/trash/server/internal/purge.ts:21-44`). The
primitive's own `DELETE` is hardcoded to `spec.table` (`define-retention.ts:76-93`), so the
side-table is the sweep target and the *pages* are removed by the callback:

```ts
// server/internal/sweep.ts
export const agentPagesSweep = defineRetention({
  table: _pageBlocksOriginExt,
  column: "createdAt",
  ttlDays: 1,
  perWorktree: true,                      // each fork sweeps its own marked pages
  beforeDelete: async (rows) => {
    for (const row of rows) await deleteBlocksSubtree([row.parentId]);
  },
});
```

- `deleteBlocksSubtree` (`editor/server/internal/trash-blocks.ts:84`) is THE delete chokepoint;
  a root page in the cascade set always takes the **trash path** (soft delete + a
  `trash_entries` row), so `BeforeDelete`/`OnTrash` hooks fire and search-index / history /
  link state is dropped correctly. Never a raw `DELETE`.
- Swept pages therefore land in **trash**, recoverable, and are hard-deleted later by trash's
  own 30-day purge. Given the marker is inferred from a header, that margin is worth having.
- The marker row is deleted by the retention `DELETE` in the same tick — which makes the sweep
  **naturally idempotent** (a trashed page is never re-swept the following night).
- `beforeDelete` must skip rows whose page is already gone or already trashed
  (`deletedAt IS NOT NULL`), so a user-deleted agent page doesn't mint a second trash entry.
- Mounted via `register: [agentPagesSweep]` in the plugin's `server/index.ts`, as
  `trash/server/index.ts:19` does.

24h comfortably covers the "open the page and see why the assertion failed" window that made
teardown unnecessary.

## Files

| Path | Change |
|---|---|
| `…/tooling/plugins/e2e-harness/e2e/browser.ts` | `extraHTTPHeaders` on `newContext` (~6 lines) |
| `page/plugins/editor/server/internal/document-hooks.ts` | add `BlockCreateHook` + `BlockLifecycle.AfterCreate` |
| `page/plugins/editor/server/internal/handle-create-block.ts` | destructure `req`; dispatch `AfterCreate` |
| `apps/pages/plugins/agent-origin/**` | **new plugin** — `core/`, `shared/resources.ts`, `server/{index,internal/{tables,resource,create-hook,sweep}}.ts`, `web/{index.ts,components/origin-field.tsx}` |
| `config/apps/pages/page-tree/pages-sidebar.jsonc` | `"groupBy": "origin"` on the `pages` view |

Copy `plugins/apps/plugins/pages/plugins/starred/` wholesale as the skeleton — same parent
table, same slot, same barrels. Registration is automatic: create the barrels and run
`./equin build`.

## Known trade-offs

1. **Grouping suspends drag-and-drop on the Pages tree.** `groupActive` drops `onMove`
   (`tree-view.tsx:440-448`) and gates `rowOrderEnabled` (`data-view-body.tsx:214`), because a
   per-section `TreeList` sees only its own roots and could mint a colliding rank against a
   hidden root in another section. This is the reason `starred` sets `groupable: false`. Turning
   `groupBy` on by default therefore **disables page reordering until fixed**.
   → **Accepted, with a follow-up task to restore DnD under grouping** (file via `add_task`
   during implementation; it is a data-view primitive fix, not part of this plan).
2. **A single-section header when no agent pages exist.** With grouping on, the tree renders a
   lone "Mine" header in the common case. Cosmetic; confirm it looks acceptable during
   verification and adjust the label if not.
3. **Restore-from-trash loses the mark.** The marker row is gone by then, so a restored agent
   page reappears as a user page. Acceptable and arguably correct — a user who restores it is
   claiming it.

## Verification

1. `./equin build` in the worktree. Confirm the generated migration for
   `page_blocks_ext_origin` is committed (`./equin check migrations-in-sync`).
2. **Marking:** `bun plugins/page/plugins/editor/e2e/copy-paste-verify.ts` (bare — hits this
   worktree). Then, via `query_db` on this worktree's DB:
   ```sql
   select o.parent_id, o.source, o.created_at, b.data->>'title'
   from page_blocks_ext_origin o join page_blocks b on b.id = o.parent_id;
   ```
   Expect exactly one row per run, `source = 'e2e:copy-paste-verify'`.
3. **Negative control:** create a page by hand in the browser at
   `http://<worktree>.localhost:9000/pages` → **no** `page_blocks_ext_origin` row. This is the
   critical assertion: a user write must never be marked.
4. **Section:** open the Pages sidebar and confirm the e2e pages sit under an **Agent** section
   with user pages under **Mine**, and that an agent page's sub-pages stay in the Agent section.
   Screenshot via
   `bun …/e2e-harness/e2e/screenshot.ts --url http://<worktree>.localhost:9000/pages --out /tmp/agentsec`.
5. **Sweep:** temporarily backdate a marker (`update page_blocks_ext_origin set created_at = now() - interval '2 days'`
   — via psql, not the read-only `query_db`), run the retention job, then assert the page has
   `deleted_at IS NOT NULL` with a `trash_entries` row, the marker row is gone, and the page
   appears in the Pages → Trash dialog (i.e. it was trashed, not hard-deleted).
6. **Regression:** `bun plugins/page/plugins/editor/e2e/block-selection-verify.ts` and
   `bun plugins/apps/plugins/pages/plugins/history/e2e/crdt-restore-verify.ts` still pass —
   the create-hook dispatch must not perturb block creation.
7. `./equin check` (boundaries, type-check, plugins-doc-in-sync).

### Cleanup of the existing damage

Separately from the code change, the seven already-leaked pages in the `singularity` DB need
removing — they predate the marker, so the sweep will not find them. Delete via the Pages UI
on `http://singularity.localhost:9000` (routes through the trash chokepoint) rather than SQL:
`block-1785248215309-k6rsw3`, `block-1785248610768-nsew3w`, `block-1785248691008-6p96mp`,
`block-1785262627220-jajl7e`, `block-1785263519956-ob7evx`, `block-1785265154713-xlm9yd`,
`block-1785266833278-6g45hc`. **Requires explicit user go-ahead — these are prod rows.**
