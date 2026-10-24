# Rank class refactor — make `localeCompare` structurally impossible

## Context

`rank` fields across the codebase are typed as plain `string`. This invites the recurring bug where agents sort them with `.localeCompare()` — locale-aware collation that mis-orders `fractional-indexing` keys (`"Z0"` must sort before `"a0"` in byte order, but most locales treat `Z ≈ z`). The last occurrence broke task tree drag-and-drop.

The fix so far (session 1) patched the comparators inline and added a lint rule. The structural fix: change `rank` to a non-string `Rank` class so TypeScript itself makes `.localeCompare()` impossible — it won't exist on the type.

## Design

### `Rank` class contract

```ts
export class Rank {
  private constructor(private readonly _v: string) {}

  static from(value: string): Rank
  static compare(a: Rank, b: Rank): -1 | 0 | 1      // replaces compareRank()
  static between(prev: Rank | null, next: Rank | null): Rank  // replaces generateKeyBetween()
  static equals(a: Rank, b: Rank): boolean

  toJSON(): string    // transparent in JSON.stringify — wire format stays plain string
  toString(): string  // same value, for template literals / debug
}
```

`Rank.between` wraps `generateKeyBetween` internally; no caller touches that function directly anymore.

### `RankSchema` — Zod boundary type

Resource schemas and route bodies receive either a plain `string` (from HTTP JSON) or an already-transformed `Rank` (when drizzle-zod validates a DB result). `RankSchema` must accept both:

```ts
export const RankSchema = z.preprocess(
  (v) => (typeof v === "string" ? Rank.from(v) : v),
  z.custom<Rank>((v) => v instanceof Rank),
);
```

### Wire format — no API changes needed

`Rank.toJSON()` returns the raw string, so `JSON.stringify({ rank: rankObj })` serializes transparently as `"rank":"a0"`. Client→server request bodies already send strings; server→client responses already send strings. The API contract is unchanged.

### Drizzle boundary — free via `customType`

Changing `rankText` to `customType<{ data: Rank; driverData: string }>` with `fromDriver`/`toDriver` means every DB query result with a `rank` column automatically returns a `Rank` object — no per-query changes needed.

---

## Implementation steps

### Step 1 — Create `Rank` class and `RankSchema`

**New file:** `plugins/primitives/plugins/rank/shared/internal/rank.ts`

- Implement `Rank` class as above (private `_v`, static methods, `toJSON`, `toString`)
- Implement `RankSchema` using `z.preprocess` + `z.custom` (accepts string | Rank, always outputs Rank)
- Import `generateKeyBetween` from `"fractional-indexing"` directly — only used inside `Rank.between`

**Update:** `plugins/primitives/plugins/rank/shared/index.ts`
- Export `Rank` and `RankSchema` from `./internal/rank`
- Remove `compareRank` re-export (replaced by `Rank.compare`)
- Remove `generateKeyBetween` re-export (now internal to `Rank.between`; callers should not use it directly)

**Update:** `plugins/primitives/plugins/rank/web/index.ts`
- Mirror: export `Rank`, `RankSchema`; remove `compareRank` and `generateKeyBetween`

### Step 2 — Update `rankText` Drizzle column

**File:** `server/src/db/types.ts`

Change from `customType<{ data: string; driverData: string }>` to:

```ts
import { Rank } from "@plugins/primitives/plugins/rank/shared";

export const rankText = customType<{ data: Rank; driverData: string }>({
  dataType: () => "rank_text",
  fromDriver: (v: string) => Rank.from(v),
  toDriver: (v: Rank) => v.toJSON(),
});
```

This is the only change needed to make all 7 DB tables return `Rank` from queries automatically:
- `plugins/agents/server/internal/tables.ts`
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/tables.ts`
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/tables.ts`
- `plugins/conversations/plugins/conversations-view/plugins/grouped/server/internal/tables.ts` (×2 tables)
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/tables.ts`
- `plugins/reorder/server/internal/tables.ts`
- `plugins/tasks-core/server/internal/tables.ts`

### Step 3 — Update server rank helpers

**File:** `plugins/primitives/plugins/rank/server/internal/helpers.ts`

- Change return type of `nextRankIn` and `nextRankUnder` from `Promise<string>` to `Promise<Rank>`
- Change internal cast from `{ rank: string }` to `{ rank: Rank }` (DB now returns `Rank` via `fromDriver`)
- Replace `generateKeyBetween(last?.rank ?? null, null)` with `Rank.between(last?.rank ?? null, null)`
- Update import: remove `generateKeyBetween`; import `Rank` from `@plugins/primitives/plugins/rank/shared`

### Step 4 — Update Zod resource schemas (8 files)

Change `rank: z.string()` → `rank: RankSchema` in:

| File | Schema |
|------|--------|
| `plugins/reorder/shared/resource.ts:6` | `ReorderSlotPrefsSchema` value object |
| `plugins/agents/shared/schemas.ts:18` | `AgentSchema` |
| `plugins/conversations/plugins/conversations-view/plugins/queue/shared/resources.ts:6` | `QueueRankRowSchema` |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/shared/internal/schemas.ts:8,17` | `ConversationGroupSchema`, `ConversationGroupMemberSchema` |
| `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/shared/resources.ts:9` | `LaunchPromptSchema` |
| `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/shared/resources.ts:8` | `QuickPromptSchema` |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/server/internal/routes.ts:24` | PATCH body Zod shape |
| `plugins/tasks-core/server/internal/schema.ts:197` | `createSelectSchema(_tasks, { rank: RankSchema })` override |

### Step 5 — Update TypeScript interfaces and local types

| File | Change |
|------|--------|
| `plugins/primitives/plugins/tree/shared/internal/tree.ts:7` | `type Node { rank: Rank }` |
| `plugins/primitives/plugins/tree/shared/internal/tree.ts:45` | `computeDrop` return `{ rank: Rank } \| null` |
| `plugins/primitives/plugins/tree/web/internal/types.ts:4` | `TreeItem { rank: Rank }` |
| `plugins/primitives/plugins/tree/web/internal/tree-list.tsx:39,43` | `onMove dest: { rank: Rank }`, `onCreate { rank?: Rank }` |
| `plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx:29,140` | `onCreate { rank?: Rank }`, `let rank: Rank` |
| `plugins/tasks/web/client.ts:11` | `TaskPatch { rank: Rank }` |
| `plugins/agents/web/components/agents-list.tsx:33` | local `AgentPatch { rank?: Rank }` |
| `plugins/reorder/server/internal/handlers.ts:21` | `Record<string, { rank: Rank }>` |
| `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx:110` | `Array<Conversation & { rank: Rank }>` |
| `plugins/tasks-core/server/internal/mutations/tasks.ts:21-28` | `UpdateTaskPatch { rank?: Rank }`, `CreateTaskInput { rank?: Rank }` |

### Step 6 — Replace all `generateKeyBetween` call sites with `Rank.between()`

All direct callers on the **server**:

| File | Lines | Change |
|------|-------|--------|
| `plugins/primitives/plugins/rank/server/internal/helpers.ts` | 20, 38 | Already handled in Step 3 |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/server/internal/repo.ts` | 35 | `generateKeyBetween(prevRank, null)` → `Rank.between(prevRank, null)` |
| `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/queue-ranks.ts` | 25, 38, 52, 66, 91, 118, 129 | All 7 calls → `Rank.between(...)`. Return types of exported functions change to `Rank`. |

All direct callers on the **client**:

| File | Lines | Change |
|------|-------|--------|
| `plugins/primitives/plugins/tree/shared/internal/tree.ts` | 57, 75, 81 | `generateKeyBetween(a, b)` → `Rank.between(a, b)` |
| `plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx` | 142, 144 | same |
| `plugins/reorder/web/internal/use-area.tsx` | 155 | same |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-conversation-list.tsx` | 264 | same |

Also in `computeDrop` and `use-tree-row.tsx`: replace `compareRank(a.rank, b.rank)` → `Rank.compare(a.rank, b.rank)`.

**Special case — `tree-list.tsx:153`:** `current.rank === dest.rank` is a reference equality guard that prevents no-op moves. With `Rank` objects, `===` is always false (different instances). Change to `Rank.equals(current.rank, dest.rank)`.

**Special case — `queue-view.tsx:122`:** Inline comparator `(a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)` compares `Rank` objects by reference (meaningless). Change to `Rank.compare(a.rank, b.rank)`.

### Step 7 — Update HTTP request body handlers

These handlers receive rank as a raw `string` from JSON and must call `Rank.from()`. No Zod is used in these handlers today (except conversation-groups which already uses Zod and is covered in Step 4).

| File | Change |
|------|--------|
| `plugins/tasks/server/internal/handle-update.ts:18` | body type `rank?: string` → after parsing, `Rank.from(body.rank)` before forwarding |
| `plugins/tasks/server/internal/handle-create.ts:23` | same |
| `plugins/agents/server/internal/handle-update.ts:25,56` | same |
| `plugins/reorder/server/internal/handlers.ts:35,40` | after the existing `typeof` guard, wrap with `Rank.from(body.rank)` |

The mutations layer (`updateTask`, `createTask`) receives `rank?: Rank` (from Step 5), so the `dbPatch.rank = patch.rank` assignment works directly — Drizzle calls `toDriver` on write.

### Step 8 — Remove `compareRank` and lint rule

- **Delete** `plugins/primitives/plugins/rank/shared/internal/compare.ts`
- **Delete** `plugins/primitives/plugins/rank/lint/index.ts`
- Remove the `lint/` folder if empty
- Update `plugins/primitives/plugins/rank/CLAUDE.md`:
  - Remove "Sorting rank strings" section referencing `compareRank()`
  - Add `Rank.compare(a, b)` and `Rank.between(a, b)` to the import-paths section
  - Update anti-patterns: remove `compareRank` entry; add `generateKeyBetween` directly as an anti-pattern (use `Rank.between()`)
  - Note that the lint rule is removed — TypeScript now enforces it structurally

---

## Files to create

- `plugins/primitives/plugins/rank/shared/internal/rank.ts` — `Rank` class + `RankSchema`

## Files to delete

- `plugins/primitives/plugins/rank/shared/internal/compare.ts`
- `plugins/primitives/plugins/rank/lint/index.ts`

## Files to modify (25 total)

**Rank primitive (3):**
- `plugins/primitives/plugins/rank/shared/index.ts`
- `plugins/primitives/plugins/rank/web/index.ts`
- `plugins/primitives/plugins/rank/server/internal/helpers.ts`

**DB layer (1):**
- `server/src/db/types.ts`

**Zod schemas (8):**
- `plugins/reorder/shared/resource.ts`
- `plugins/agents/shared/schemas.ts`
- `plugins/conversations/plugins/conversations-view/plugins/queue/shared/resources.ts`
- `plugins/conversations/plugins/conversations-view/plugins/grouped/shared/internal/schemas.ts`
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/shared/resources.ts`
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/shared/resources.ts`
- `plugins/conversations/plugins/conversations-view/plugins/grouped/server/internal/routes.ts`
- `plugins/tasks-core/server/internal/schema.ts`

**Server handlers and mutations (5):**
- `plugins/tasks/server/internal/handle-update.ts`
- `plugins/tasks/server/internal/handle-create.ts`
- `plugins/tasks-core/server/internal/mutations/tasks.ts`
- `plugins/agents/server/internal/handle-update.ts`
- `plugins/reorder/server/internal/handlers.ts`

**Server rank logic (2):**
- `plugins/conversations/plugins/conversations-view/plugins/grouped/server/internal/repo.ts`
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/queue-ranks.ts`

**Client tree/reorder primitives (3):**
- `plugins/primitives/plugins/tree/shared/internal/tree.ts`
- `plugins/primitives/plugins/tree/web/internal/types.ts`
- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx`
- `plugins/primitives/plugins/tree/web/internal/use-tree-row.tsx`
- `plugins/reorder/web/internal/use-area.tsx`

**Client feature code (3):**
- `plugins/tasks/web/client.ts`
- `plugins/agents/web/components/agents-list.tsx`
- `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-conversation-list.tsx`
- `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx`

**Docs (1):**
- `plugins/primitives/plugins/rank/CLAUDE.md`

---

## Verification

1. `./equin build` — TypeScript compile must pass with zero errors. Any missed `rank: string` site will surface as a type error.
2. `./equin check --plugin-boundaries` — no new violations (imports of `Rank` and `RankSchema` from rank shared/web barrels are legal cross-plugin paths).
3. `./equin check --eslint` — lint rule is removed; check still passes (no rule to fail).
4. Drag tasks in the UI — items land in the correct position.
5. Drag agents in the sidebar — same.
6. Create a task below an existing one (Tab key or +) — new task ranks correctly after its sibling.
7. Reorder sidebar items (pen mode) — items land correctly.
8. TypeScript as the enforcer: add `rows.sort((a, b) => a.rank.localeCompare(b.rank))` to any plugin file — `tsc` should immediately error: *Property 'localeCompare' does not exist on type 'Rank'*.
