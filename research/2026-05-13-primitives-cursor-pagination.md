# Cursor-Pagination Primitive

## Context

Two conversation sidebar views (`history-view.tsx` and `grouped-view.tsx`) duplicate ~40 lines of identical cursor-pagination logic: a frozen cursor captured from a live-state resource, `useInfiniteQuery` wiring, `IntersectionObserver` auto-fetch, page flattening, and live/paginated dedup. Other growing lists (tasks, JSONL events) will need the same pattern as they scale. A shared primitive extracts this into a reusable hook so list plugins can adopt cursor-based pagination without reimplementing the plumbing.

## Approach

New primitive plugin at `plugins/primitives/plugins/cursor-pagination/` with a `core/` layer (shared `CursorPage<T>` type + Zod schema factory) and a `web/` layer (the `useCursorPagination` hook + `ScrollSentinel` component). Then refactor both conversation views to use it.

### Key design decision: `fetchPage` callback over `url + schema`

The hook receives a `fetchPage: (cursor: string, pageSize: number) => Promise<CursorPage<T>>` callback rather than baking in URL conventions (`?before=<cursor>&limit=<n>`). Rationale:
- The HTTP convention (`before`, `limit`, `cursor` param names) is endpoint-specific — future paginated endpoints may differ.
- The hook's job is pagination *state management* (frozen cursor, infinite query, observer, dedup), not HTTP fetching.
- Callers already import their domain-specific Zod schema; the 3-line fetch callback is minimal overhead.

## File Plan

### New files

**`plugins/primitives/plugins/cursor-pagination/package.json`**
```json
{ "name": "@singularity/plugin-primitives-cursor-pagination", "private": true, "version": "0.0.1" }
```

**`plugins/primitives/plugins/cursor-pagination/core/internal/types.ts`**
- `CursorPage<T>` — `{ items: T[]; hasMore: boolean }` generic page shape
- `cursorPageSchema(itemSchema: ZodType<T>)` — factory returning `z.object({ items: z.array(itemSchema), hasMore: z.boolean() })`

**`plugins/primitives/plugins/cursor-pagination/core/index.ts`**
- Re-exports `CursorPage`, `cursorPageSchema`

**`plugins/primitives/plugins/cursor-pagination/web/internal/use-cursor-pagination.ts`**

```ts
interface UseCursorPaginationOptions<T> {
  queryKey: string[];
  fetchPage: (cursor: string, pageSize: number) => Promise<CursorPage<T>>;
  cursor: string | null;         // from tail of live window; frozen on first non-null
  getCursor: (item: T) => string; // extracts cursor from last item of a page
  enabled?: boolean;              // default true
  pageSize?: number;              // default 20
  liveIds?: Set<string>;          // IDs to exclude (dedup against live window)
  getId?: (item: T) => string;    // extracts ID for dedup; required when liveIds given
}

interface CursorPaginationHandle<T> {
  items: T[];                     // flattened, deduped paginated items
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
  fetchNextPage: () => void;
}
```

Implementation encapsulates:
1. **Frozen cursor** — `useRef` initialized on first non-null `cursor` value; never updates after.
2. **`useInfiniteQuery`** — `queryKey` includes the frozen cursor; `getNextPageParam` uses `getCursor`; `staleTime: Infinity`.
3. **Page flattening + dedup** — `useMemo` over `data.pages.flatMap(p => p.items)`, filtered by `liveIds`/`getId` when provided.
4. **IntersectionObserver** — `useEffect` attaching to `sentinelRef.current`; triggers `fetchNextPage()` on intersection.

**`plugins/primitives/plugins/cursor-pagination/web/internal/scroll-sentinel.tsx`**

```ts
interface ScrollSentinelProps {
  sentinelRef: RefObject<HTMLDivElement | null>;
  show: boolean;
}
```

Renders `<div ref={sentinelRef} className="h-px" />` when `show` is true, `null` otherwise.

**`plugins/primitives/plugins/cursor-pagination/web/index.ts`**
- Re-exports everything from `internal/*` plus `core/`
- Default export: `PluginDefinition` with `id: "cursor-pagination"`, `contributions: []`

### Modified files

**`plugins/conversations/web/use-conversations.ts`**
- Replace hand-rolled `GonePageSchema` with `cursorPageSchema(ConversationSchema)` from the new `core/` barrel.

**`plugins/conversations/plugins/conversations-view/plugins/history/web/components/history-view.tsx`**
- Remove: `useInfiniteQuery` import, `cursorRef`, `useInfiniteQuery({...})` block, `liveIds` useMemo, `paginatedItems` useMemo, `sentinelRef` + `useEffect` + IntersectionObserver (~40 lines).
- Add: `useCursorPagination` + `ScrollSentinel` imports, ~10 lines of hook call + sentinel render.

**`plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-view.tsx`**
- Same transformation as `history-view.tsx`. `paginatedItems` prop to `<GroupedConversationList>` unchanged.

## Resulting caller pattern (history-view)

```tsx
import { useCursorPagination, ScrollSentinel } from "@plugins/primitives/plugins/cursor-pagination/web";

const cursor = hasMoreGone && recentGone.length > 0
  ? (recentGone.at(-1)!.endedAt ?? recentGone.at(-1)!.createdAt).toISOString()
  : null;

const liveIds = useMemo(() => new Set(liveItems.map(c => c.id)), [liveItems]);

const { items: paginatedItems, hasNextPage, isFetchingNextPage, sentinelRef } =
  useCursorPagination({
    queryKey: ["conversations-gone-paginated"],
    fetchPage: async (before, limit) => {
      const params = new URLSearchParams({ before, limit: String(limit) });
      const res = await fetch(`/api/conversations/gone?${params}`);
      if (!res.ok) throw new Error("Failed to fetch gone conversations");
      return GonePageSchema.parse(await res.json());
    },
    cursor,
    enabled: hasMoreGone,
    getCursor: (c) => (c.endedAt ?? c.createdAt).toISOString(),
    liveIds,
    getId: (c) => c.id,
  });

// In JSX:
<ScrollSentinel sentinelRef={sentinelRef} show={hasNextPage} />
```

## Verification

1. `rg "useInfiniteQuery|IntersectionObserver" plugins/conversations` → zero results (all moved to primitive)
2. `rg "Conversation|tasks-core" plugins/primitives/plugins/cursor-pagination` → zero results (no domain types in primitive)
3. Scroll History tab with 30+ gone conversations — pages load as sentinel enters viewport
4. Scroll Grouped tab — same behavior, items append below recentGone
5. Mid-scroll, trigger a WS push (close a conversation) — paginated chain doesn't reset
6. `./equin check` passes
7. `./equin build` succeeds and both views render correctly
