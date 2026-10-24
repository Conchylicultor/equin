# Rank Primitive Plugin

## Context

Agents writing new sortable-list features keep reaching for `float` or `integer` rank
columns. The correct primitive (`fractional-indexing`) already exists in the codebase
but is invisible — scattered across five private ~10-line helpers in agents, launch-prompts,
quick-prompts, grouped, and tasks-core. Making it a named entry in `plugins-compact.md`
gives future agents a clear, searchable target.

## Decision: under `primitives/plugins/rank/`

`primitives` is for cross-cutting utility primitives; `infra` is for infrastructure
daemons (jobs, events, secrets, MCP). A rank helper is a utility, not infrastructure.
The sub-plugin has `shared/` (client + server), `server/` (DB helpers), and a thin
`web/` (just the `PluginDefinition` for discoverability in `plugins-compact.md`).

---

## New files to create

### `plugins/primitives/plugins/rank/package.json`
```json
{
  "name": "@singularity/plugin-primitives-rank",
  "private": true,
  "version": "0.0.1"
}
```

### `plugins/primitives/plugins/rank/shared/index.ts`
```ts
export { generateKeyBetween } from "fractional-indexing";
```

### `plugins/primitives/plugins/rank/server/internal/helpers.ts`
```ts
import { desc, eq, isNull } from "drizzle-orm";
import { type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";
import { generateKeyBetween } from "fractional-indexing";
import { db } from "@server/db/client";

export type RankExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Appends after the current last row in a flat table.
export async function nextRankIn(
  table: PgTable & { rank: AnyPgColumn },
  executor: RankExecutor = db,
): Promise<string> {
  const [last] = await executor
    .select({ rank: table.rank })
    .from(table)
    .orderBy(desc(table.rank))
    .limit(1);
  return generateKeyBetween(last?.rank ?? null, null);
}

// Appends after the last sibling sharing the same parent value.
// Pass the parent column explicitly (may be named parentId, groupId, etc.).
export async function nextRankUnder(
  table: PgTable & { rank: AnyPgColumn },
  parentCol: AnyPgColumn,
  parentId: string | null,
  executor: RankExecutor = db,
): Promise<string> {
  const [last] = await executor
    .select({ rank: table.rank })
    .from(table)
    .where(parentId === null ? isNull(parentCol) : eq(parentCol, parentId))
    .orderBy(desc(table.rank))
    .limit(1);
  return generateKeyBetween(last?.rank ?? null, null);
}
```

### `plugins/primitives/plugins/rank/server/index.ts`
```ts
import type { ServerPluginDefinition } from "@server/types";
export { nextRankIn, nextRankUnder } from "./internal/helpers";
export type { RankExecutor } from "./internal/helpers";
// Re-export so agents implementing a ranked table find both the column type
// and the helpers in one place (canonical source stays @server/db/types).
export { rankText } from "@server/db/types";

export default {
  id: "rank",
  name: "Rank",
  description:
    "Fractional-indexing rank primitive. THE authoritative source for sortable rank strings. Use nextRankIn() for flat tables, nextRankUnder() for parent-scoped lists. Re-exports rankText column type. Never use floats or integers.",
} satisfies ServerPluginDefinition;
```

### `plugins/primitives/plugins/rank/web/index.ts`
```ts
import type { PluginDefinition } from "@core";
export { generateKeyBetween } from "../shared";

export default {
  id: "rank",
  name: "Rank",
  description:
    "Fractional-indexing rank primitive. THE authoritative source for sortable rank strings — use nextRankIn()/nextRankUnder() from the server barrel for new insertions; use computeDrop() from tree for DnD moves. Never use floats or integers.",
  contributions: [],
} satisfies PluginDefinition;
```

### `plugins/primitives/plugins/rank/CLAUDE.md`
```markdown
# rank

## DO NOT use floats or integers for ordered lists

Use this plugin. `fractional-indexing` strings ("a0", "V0m", "Zz9…") can always
insert between any two neighbors, sort correctly under the `rank_text` PostgreSQL
domain (C collation = byte order), and never need a full-list rewrite.

## When to use this vs tree's `computeDrop`

- **`computeDrop` (`@plugins/primitives/plugins/tree/shared`)** — client-side DnD:
  computes the rank for an item *moved between two existing neighbors*. Call it in
  `onDragEnd` / `onDrop` handlers.

- **`nextRankIn` / `nextRankUnder` (this plugin, server barrel)** — server-side
  *inserts*: generates the rank for a new item appended at the end of a list.

## Import paths

```ts
// Server — inserting a new row
import { nextRankIn, nextRankUnder } from "@plugins/primitives/rank/server";

// Server — declaring a rank column on a new table (also importable from @server/db/types)
import { rankText } from "@plugins/primitives/rank/server";

// Shared / client — raw key generation when neither helper fits
import { generateKeyBetween } from "@plugins/primitives/rank/shared";
```

## Anti-patterns

- `rank: integer` / `rank: float` — can't insert between adjacent integers; floats lose precision
- `ORDER BY createdAt` as a proxy for user order
- `MAX(rank) + 1` — the integer trap
- Calling `generateKeyBetween` on the server without first querying the current last rank

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->
<!-- AUTOGENERATED:END -->
```

---

## Files to edit

### `server/src/plugins.ts`
Add at the top of the import list (before `tasksCorePlugin` — it depends on rank):
```ts
import rankPlugin from "@plugins/primitives/plugins/rank/server";
```
Add `rankPlugin` to the `plugins` array, near the top with other utility plugins.

### `web/src/plugins.ts`
Add an import for the rank web plugin and push it to the plugins array. Pattern:
```ts
import rankPlugin from "@plugins/primitives/plugins/rank/web";
```

### `plugins/agents/server/internal/rank.ts` — full replacement
```ts
import { nextRankUnder } from "@plugins/primitives/rank/server";
import { _agents } from "./tables";

export async function nextAgentRankUnder(parentId: string | null): Promise<string> {
  return nextRankUnder(_agents, _agents.parentId, parentId);
}
```

### `plugins/conversations/.../launch-prompts/server/internal/rank.ts` — full replacement
```ts
import { nextRankIn } from "@plugins/primitives/rank/server";
import { launchPromptsTable } from "./tables";

export async function nextRank(): Promise<string> {
  return nextRankIn(launchPromptsTable);
}
```

### `plugins/conversations/.../quick-prompts/server/internal/rank.ts` — full replacement
```ts
import { nextRankIn } from "@plugins/primitives/rank/server";
import { quickPromptsTable } from "./tables";

export async function nextRank(): Promise<string> {
  return nextRankIn(quickPromptsTable);
}
```

### `plugins/conversations/.../grouped/server/internal/repo.ts`
Remove `nextGroupRank` and `nextMemberRank` private helpers. Replace their call sites:
- `nextGroupRank(tx)` → `nextRankIn(_conversationGroups, tx)`
- `nextMemberRank(tx, groupId)` → `nextRankUnder(_conversationGroupMembers, _conversationGroupMembers.groupId, groupId, tx)`

Note: `_conversationGroupMembers` uses `groupId` (not `parentId`) — that's why
`nextRankUnder` takes the column explicitly rather than assuming a `parentId` field.

### `plugins/tasks-core/server/internal/queries/tasks.ts`
`findNextRankUnder` stays in the public API (can't be removed). Delegate its body:
```ts
import { nextRankUnder, type RankExecutor } from "@plugins/primitives/rank/server";

export async function findNextRankUnder(
  parentId: string | null,
  executor: RankExecutor = db,
): Promise<string> {
  return nextRankUnder(_tasks, _tasks.parentId, parentId, executor);
}
```
Remove the now-unused imports (`desc`, `eq`, `isNull`, `generateKeyBetween`).

---

## Verification

```bash
./equin build
```

- TypeScript must compile with no errors (Drizzle generic types)
- `plugins-compact.md` will gain a `rank` entry under primitives sub-plugins
- The 5 migrated call sites keep the same external function signatures — no callers change
