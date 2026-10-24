# Validate `page_blocks.data` at the write boundary, per block type

## Context

`POST /api/blocks` declares `data: z.unknown().optional()` and every write handler
persists `body.data ?? {}` verbatim. Nothing on the server ever resolves
`type → schema`, so a caller can create a `type="page"` block whose `data` is
`{title: "x"}` — no `icon` key. The write succeeds.

Every *reader* then crashes, because `PageDataSchema.icon` is `.nullable()` but not
`.optional()`:

```ts
// plugins/page/plugins/editor/core/schemas.ts:68
export function pageData(block: Pick<Block, "data">): PageData {
  return PageDataSchema.parse(block.data);   // ZodError: invalid_type at ["icon"]
}
```

Reproduced during website-app verification: opening such a page crashed
`apps.surface` / `apps-core.surface` (tab-title derivation). The blast radius is
wider than the tab title — `pageData()` is also called inside a **push resource
loader** (`website/blog/publish/server/internal/resource.ts:37`), the **search
reindex job** (`pages/content-search/.../reindex-page.ts:51`), and
`serializePageContent()` (history restore / duplicate / export). One malformed row
breaks a live subscription and a background job for everyone on that database.

**The class of bug, not the instance.** All 21 block types already declare a zod
schema for their `data`, and all 21 live in `core/` (isomorphic, importable by the
server). The only thing missing is a server-reachable `type → schema` lookup: the
registry (`Editor.Block`) is a **web-only** `defineDispatchSlot`. So the data is
validated on the way *out* by whichever reader happens to parse it, and never on
the way *in*. Readers crash; the row that caused it survives.

The fix is to validate `data` against its block type's schema at the write
boundary, and to make skipping that validation a **compile error** rather than a
convention.

### Two real bugs this exposes

Investigating turned up a second, pre-existing instance of the same class. Three
call sites blind-spread `text` onto *any* target block type's payload:

```ts
// slash-menu-plugin.tsx:179, keyboard-plugin.tsx:98, markdown-shortcut-plugin.tsx:106-108
editor.convertTo(handle.type, { ...(handle.empty?.() ?? {}), text: remaining });
```

For a void block type (`audio`, `divider`, `image`, `embed`, …) that writes a `text`
key the schema has never heard of. `divider-block.ts` even documents the reliance on
nobody checking: *"the schema has no `text` field so it is harmlessly dropped"* — it
is not dropped, it is **stored**. Main's DB has the receipt: the single `audio` row
in `page_blocks` has exactly one key, `text`, and no `attachmentId`.

That settles the "store the zod output?" question. **Silently stripping unknown keys
would hide exactly this bug** — the write would be canonicalized, the slash menu would
keep injecting `text`, and nobody would ever learn. It is the absorbable-failure
pattern the repo bans. So: unknown keys are a **loud 400**, and the three call sites
get fixed to carry `text` only into text-bearing targets.

## Design

### 1. A branded `BlockData` that only the validator can mint

```ts
// plugins/page/plugins/editor/core/schemas.ts  (type-only, no runtime)
declare const blockDataBrand: unique symbol;
export type BlockData = Record<string, unknown> & { readonly [blockDataBrand]: never };
```

```ts
// plugins/page/plugins/editor/server/internal/tables.ts
data: jsonb("data").notNull().default({} as BlockData).$type<BlockData>(),
```

`$type<>` is type-only — no migration, no DDL change. Reads are unaffected
(`BlockData` is assignable to the `unknown` that `pageData()` / `BlockSchema` take).
**Writes now fail to compile** unless the value came from `parseBlockData()`, which is
the sole minting site. That is what makes this structural rather than a patch: the
seven existing write sites are fixed *and* an eighth one added next year cannot skip
validation.

### 2. A server-reachable `type → handle` registry

`Editor.Block` is a web slot; the server needs its own. Mirror the
`Fields.Storage` precedent (`plugins/fields/plugins/server-capabilities/server/internal/storage.ts`)
— a plain `defineServerContribution`, no eager-index wrapper (that exists only because
`resolveFieldStorage` runs at module-eval inside `defineEntity`; block validation runs
at request time, long after `collectContributions`).

```ts
// plugins/page/plugins/editor/server/internal/block-registry.ts
export const Editor = {
  /** Per-type `data` schema. Contribute the block handle; keyed by `type`. */
  BlockData: defineServerContribution<BlockHandle<unknown>>("page.block-data", {
    docLabel: (h) => h.type,
  }),
};

export function resolveBlockHandle(type: string): BlockHandle<unknown> | undefined;
```

`resolveBlockHandle` must **throw on duplicate registration** for a type — two plugins
claiming one `type` is a boot-time defect, not a last-write-wins.

Each block-type plugin gains a one-line server barrel, exactly like a field type's
`storage` barrel:

```ts
// plugins/page/plugins/text/server/index.ts
import { Editor } from "@plugins/page/plugins/editor/server";
import { textBlock } from "../core";

export default {
  description: "Plain-text block type: server-side `data` schema.",
  contributions: [Editor.BlockData(textBlock)],
} satisfies ServerPluginDefinition;
```

**`page` is registered by `editor/server` itself, not by `sub-page`.** `editor/core`
owns `PAGE_BLOCK_TYPE` and `PageDataSchema`, and `handle-turn-into-page` /
`replacePageContent` write page rows directly — page creation must not depend on the
`sub-page` renderer plugin being enabled. `sub-page` keeps contributing only its web
renderer. That leaves **20 new server barrels** (`bookmark` and `page-link` already have
a `server/` dir — they just add the contribution).

### 3. `parseBlockData` — the only minting function

```ts
// plugins/page/plugins/editor/server/internal/parse-block-data.ts
export function parseBlockData(type: string, data: unknown): BlockData {
  const handle = resolveBlockHandle(type);
  if (!handle) throw new HttpError(400, `Unknown block type "${type}"`);
  const result = handle.schema.strict().safeParse(data ?? handle.empty?.() ?? {});
  if (!result.success) {
    throw new HttpError(400, `Invalid data for block type "${type}": ${…issues}`);
  }
  return result.data as BlockData;
}
```

- **Missing required key → 400.** The reported bug.
- **Unknown key → 400.** The `text`-into-`audio` bug. Loud, not stripped.
- **Absent `data` → the type's `empty()`**, then validated. Today `data ?? {}` writes
  `{}` into a `page` row, which is precisely the malformed shape.
- **Output is stored**, so `.default()`s materialize (e.g. `PageCoverSchema.positionY`).
  Since unknown keys now throw, storing the output can no longer lose data.

`.strict()` needs `defineBlock`'s `S extends ZodTypeAny` tightened to
`S extends z.AnyZodObject`. Every one of the 21 schemas is already a `z.object` (zod
v3 — `.strict()` is available). Note the scope: `.strict()` is **top-level only**;
nested objects (`cover`, text runs) keep zod's default strip. Tightening those is a
follow-up, not a prerequisite.

### 4. Wire the write sites (the compiler lists them)

| File | Change |
|---|---|
| `handle-create-block.ts:45` | `data: parseBlockData(body.type, body.data)` |
| `handle-update-block.ts:12` | `SELECT type` first; validate against `body.type ?? row.type`. Reject `type` supplied without `data` (400) — today that leaves the old type's payload under a new type. |
| `handle-patch-blocks.ts:113,129` | map upserts through `parseBlockData(b.type, b.data)` |
| `handle-apply-block-op.ts:78,93` | same |
| `handle-turn-into-page.ts:52,72` | page row + `body.seedChild` |
| `forest.ts:71` (`insertForest`) | `data: parseBlockData(node.type, node.data)` — covers paste, bulk-duplicate, and history restore in one place |
| `page-content.ts:136` (`replacePageContent`) | `data: parseBlockData(PAGE_BLOCK_TYPE, snapshot.page)` |

`handle-move-block`, `handle-bulk-move-block`, and `rank-park` touch only
rank/parent — no change.

### 5. Fix the `text`-injection call sites

Derive text-bearing-ness from the schema, never from a type name — `defineBlock` gains
`acceptsText` (computed once: `"text" in schema.shape`). Then:

```ts
// slash-menu-plugin.tsx:179, keyboard-plugin.tsx:98, markdown-shortcut-plugin.tsx:106
const base = handle.empty?.() ?? {};
editor.convertTo(handle.type, handle.acceptsText ? { ...base, text: remaining } : base);
```

Drop the now-false comment in `divider-block.ts` about `text` being "harmlessly dropped".

### 6. A check, so a new block type can't forget

`plugins/page/plugins/editor/check/index.ts` (the repo's first plugin-contributed
check — `check/index.ts` discovery already exists per the root `CLAUDE.md`):

> `page.editor:block-data-registered` — every plugin contributing `Editor.Block` (web)
> must also contribute `Editor.BlockData` (server).

Read both contribution sets from the faceted plugin tree (the same facet that renders
`Contributes: Editor.Block → …` into `docs/plugins-details.md`) — not a text scan
(`no-adhoc-marker-scan`). Without this, a new block type's missing server barrel is
discovered by a user's first insert 400ing.

### 7. Repair the existing rows

Hand-written DML migration, following `20260709_132244_5eacdb94__repair_duplicate_sibling_ranks.sql`.
Both statements are guarded and idempotent (fork-safe):

```sql
-- pages created without an icon key (the reported crash)
UPDATE page_blocks SET data = jsonb_set(data, '{icon}', 'null')
WHERE type = 'page' AND NOT (data ? 'icon');

-- `text` injected into void block types by the slash / markdown convert path
UPDATE page_blocks SET data = data - 'text'
WHERE data ? 'text'
  AND type IN ('audio','bookmark','divider','embed','equation','file',
               'image','page','page-link','video','code-block');
```

Main's `page` rows are all clean today; its one `audio` row is not. Worktree DBs (incl.
the one that reproduced this) are forks and may carry both. Naming types in a DML
migration is fine — a migration is a snapshot of history, not live code.

## Critical files

- `plugins/page/plugins/editor/core/schemas.ts` — `BlockData` brand, `PageDataSchema`, `pageData()`
- `plugins/page/plugins/editor/core/define-block.ts` — `S extends AnyZodObject`, `acceptsText`
- `plugins/page/plugins/editor/server/internal/{block-registry,parse-block-data}.ts` — new
- `plugins/page/plugins/editor/server/internal/tables.ts` — `$type<BlockData>()`
- `plugins/page/plugins/editor/server/internal/{handle-create-block,handle-update-block,handle-patch-blocks,handle-apply-block-op,handle-turn-into-page,forest,page-content}.ts`
- `plugins/page/plugins/editor/web/components/{slash-menu-plugin,keyboard-plugin,markdown-shortcut-plugin}.tsx`
- `plugins/page/plugins/<type>/server/index.ts` × 20 — new one-line barrels
- `plugins/page/plugins/editor/check/index.ts` — new
- `plugins/database/plugins/migrations/data/<ts>__repair_block_data.sql` — new

## Reuse (do not re-invent)

- `defineServerContribution` — `@plugins/framework/plugins/server-core/core`
- The registry shape — copy `plugins/fields/plugins/server-capabilities/server/internal/storage.ts`
- The one-line contribution barrel — copy `plugins/fields/plugins/text/plugins/storage/server/index.ts`
- `HttpError` — `@plugins/infra/plugins/endpoints/server`
- `BlockHandle` / `defineBlock` — `plugins/page/plugins/editor/core/define-block.ts`
- Existing per-type schemas — all 21 already in `plugins/page/plugins/<type>/core/*-block.ts`

## Verification

1. `./equin build` (regenerates the server registry from the 20 new barrels;
   runs `check`, incl. the new `block-data-registered`).
2. **The reported bug, directly** — the write is now rejected:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<wt>.localhost:9000/api/blocks \
     -H 'content-type: application/json' \
     -d '{"parentId":null,"type":"page","data":{"title":"x"}}'   # expect 400, was 201
   curl … -d '{"parentId":null,"type":"page","data":{"title":"x","icon":null,"junk":1}}'  # expect 400 (unknown key)
   curl … -d '{"parentId":null,"type":"page","data":{"title":"x","icon":null}}'           # expect 200
   ```
3. **No malformed rows can remain** — after the migration:
   ```sql
   SELECT type, count(*) FROM page_blocks
   WHERE (type='page' AND NOT data ? 'icon') OR (type='audio' AND data ? 'text')
   GROUP BY type;   -- expect 0 rows
   ```
4. **The reader that crashed** — open a page in the Pages app and confirm the tab title
   renders (`apps.surface` no longer throws). Open the page that owns main's `audio`
   row and confirm it renders.
5. **The convert path, end-to-end** (this is what regressed silently before): in the
   editor, `/divider`, `/audio`, `/code`, `/todo` from the slash menu; `---` and
   ` ``` ` markdown shortcuts; Backspace-at-start reset. Each must convert without a
   400 and without writing a `text` key:
   ```sql
   SELECT type, jsonb_object_keys(data) FROM page_blocks WHERE type='divider';
   ```
6. **Round-trips over the strict boundary** — type, undo (Cmd+Z), redo, cut/paste a
   subtree, duplicate a page, restore a version from Version history. Each drives
   `patchBlocks` / `applyBlockOp` / `insertForest` / `replacePageContent` with rows read
   back from the DB; a canonicalization bug shows up here as a 400.
7. `bun test plugins/page/plugins/editor` and `bun run test:dom plugins/page`.
8. Add `bun:test` unit coverage for `parseBlockData`: missing required key → 400,
   unknown key → 400, absent data → `empty()`, unknown type → 400, duplicate
   registration → throws.
