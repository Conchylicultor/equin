# rank

## DO NOT use floats or integers for ordered lists

Use this plugin. `fractional-indexing` strings ("a0", "V0m", "Zz9…") can always
insert between any two neighbors, sort correctly under the `rank_text` PostgreSQL
domain (C collation = byte order), and never need a full-list rewrite.

## Which minter

- **`computeDrop` (`@plugins/primitives/plugins/tree/core`)** — a DnD rank
  predicted CLIENT-side. Legal only for a holder of the COMPLETE sibling set (in
  practice: the page editor's own forest, for its optimistic overlay). Every
  projection uses the rank-free `resolveDropParent` and sends the anchor.

- **`nextRankIn` / `nextRankUnder` (this plugin, server barrel)** — server-side
  *inserts*: generates the rank for a new item appended at the end of a list.
  Both accept an optional `executor` (a `tx` from `db.transaction`) so they
  compose safely inside transactions.

- **`rankAdjacentTo` (this plugin, server barrel)** — THE server-side resolver for
  a **DnD move**: the wire carries positional intent `(targetId, zone)` — the
  shape the tree/data-view drop contract emits — and this mints the rank against
  the caller-loaded COMPLETE sibling set. `targetId === null` addresses the list
  boundary (`"after"` appends, `"before"` prepends); `excludeIds` keeps the moved
  row from bounding its own insertion. Pure, so call it inside the write's own
  transaction. A tied neighbourhood does not abort — see its doc comment.

- **`rankAfterSibling` (this plugin, server barrel)** — the `afterId`-shaped
  sibling of `rankAdjacentTo`, for server-side *positional inserts*: the rank that
  places a new row immediately after an anchor row among its true siblings
  (`afterId === null` prepends at the start). Reads its own neighbourhood from the
  DB rather than a supplied set; `executor`-composable like `nextRankUnder`.

  **Rank arithmetic is only valid over the COMPLETE sibling set**, which is why
  this is a server API. A client usually holds a *filtered projection* of a
  shared ordering space (a searched tree, a status-filtered list): a rank it
  mints between two *visible* neighbours can collide with an invisible row
  sitting between them (this really happened — two `page_blocks` siblings both
  at `"a0"`). So a client must send **positional intent** — an anchor id — and
  never a client-minted rank. A bad anchor throws; it never silently degrades
  into an append.

## Storage -> wire: `withRank`

A `rank` COLUMN stores the raw fractional-indexing key (its value type is
`string`, which keeps `table.$inferSelect` honest — see
`plugins/fields/plugins/rank`), while the WIRE schemas declare the `Rank` value
object via `RankSchema`. So a stored row and its wire type differ in exactly one
field, and `withRank(row)` is THE one spelling of that difference:

```ts
import { withRank } from "@plugins/primitives/plugins/rank/server";

export async function listTasks(): Promise<Task[]> {
  return (await db.select().from(tasks)).map(withRank);
}
```

Never assert the difference away (`as unknown as Task[]`). The point of the
named conversion is what `tsc` then checks: mapping against a DECLARED return
type is a checked assignment, so every OTHER field must line up — a column that
stops matching its wire schema becomes a compile error instead of a laundered
lie. `RankSchema` accepts an already-wrapped `Rank`, so a live-state loader
whose output the resource runtime re-parses stays correct.

## Import paths

```ts
// Server — inserting a new row at the end of a flat table
import { nextRankIn } from "@plugins/primitives/plugins/rank/server";

// Server — inserting under a parent (parentId, groupId, etc.)
import { nextRankUnder } from "@plugins/primitives/plugins/rank/server";

// Server — resolving a DnD move's (targetId, zone) against the loaded siblings
import { rankAdjacentTo } from "@plugins/primitives/plugins/rank/server";
// rankAdjacentTo(rows, parentId, targetId, zone, excludeIds)
// rows: readonly { id, parentId, rank: Rank | string }[] — the COMPLETE set
// targetId === null → "after" appends, "before" prepends

// Server — inserting immediately after an anchor sibling (positional intent)
import { rankAfterSibling } from "@plugins/primitives/plugins/rank/server";
// rankAfterSibling(table, parentCol, parentId, afterId, idCol, executor?)
// afterId === null → prepend at the start of the sibling list

// Server — declaring a rank column on a new table schema
import { rankText } from "@plugins/primitives/plugins/rank/server";

// Shared / client — computing a rank between two neighbors
import { Rank } from "@plugins/primitives/plugins/rank/shared";
// Rank.between(prev, next) — generates a key between two Rank values (or null for open ends)
// Rank.compare(a, b)       — byte-order sort comparator (-1 | 0 | 1)
// Rank.equals(a, b)        — identity check (use instead of ===)
// Rank.from(str)           — wrap a raw string (e.g. from HTTP body)

// Shared / client — Zod schema that accepts string | Rank and always outputs Rank
import { RankSchema } from "@plugins/primitives/plugins/rank/shared";

// Server — converting a stored row (raw `rank` key) into its wire type
import { withRank } from "@plugins/primitives/plugins/rank/server";
// rows.map(withRank) — see "Storage -> wire" above
```

## Anti-patterns

- `rank: integer` / `rank: float` — can't insert between adjacent integers; floats lose precision
- `ORDER BY createdAt` as a proxy for user order
- `MAX(rank) + 1` — the integer trap
- Calling `generateKeyBetween` directly — use `Rank.between()` instead
- Sorting with `.localeCompare()` — TypeScript now prevents it; `Rank` has no such method
- Comparing `Rank` objects with `===` — use `Rank.equals(a, b)`

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Fractional-indexing rank primitive. THE authoritative source for sortable rank strings — use nextRankIn()/nextRankUnder() from the server barrel for new insertions; use rankAdjacentTo() from the server barrel to resolve a DnD move's anchor. Never use floats or integers. THE authoritative source for sortable rank strings. Use nextRankIn() for flat tables, nextRankUnder() for parent-scoped lists. Re-exports rankText column type. Never use floats or integers for ordering.
- Server:
  - Uses: `database.db`
  - Exports (types):
    - `RankAdjacentRow`
    - `Ranked`
    - `RankExecutor`
  - Exports (values):
    - `nextRankIn`
    - `nextRankUnder`
    - `rankAdjacentTo`
    - `rankAfterSibling`
    - `rankText`
    - `withRank`
- Cross-plugin:
  - Imported by:
    - `apps/agent-manager/demo`
    - `apps/studio/explorer`
    - `config_v2`
    - `conversations/agents`
    - `conversations/conversations-view/grouped`
    - `conversations/conversations-view/queue`
    - `fields/rank/config`
    - `page/editor`
    - `page/markdown-apply`
    - `primitives/data-view/view-order`
    - `primitives/tree`
    - `tasks`
    - `tasks/tasks-core`
- Web:
  - Exports (values):
    - `Rank`
    - `RankSchema`
- Core:
  - Exports (types):
    - `Ranked`
    - `RankedItem`
  - Exports (values):
    - `computeFlatReorder`
    - `Rank`
    - `RankSchema`
    - `rankText`
    - `withRank`

<!-- AUTOGENERATED:END -->
