# Layout Chain: Decouple Pane Layout from URL Routing

## Context

Today the URL is the single source of truth for layout. `matchRegistry(pathname)` returns an ordered chain derived from the pane parent→child hierarchy, and Miller columns renders that chain directly. This coupling means:

- You can only open panes to the **right** (deeper URL). Opening to the left (wrapping with a context/container pane) is impossible.
- The parent→child hierarchy bakes URL nesting and layout order into a single concept.
- Future layout types (tabs, overlays, splits) can't be added without URL gymnastics.

The concrete use case: opening the attempt view **to the left** of a conversation so the user can switch across conversations within an attempt. URL: `/c/456` → `/a/123/c/456`.

This plan introduces a **LayoutChain** — an ordered list of active panes that is the primary source of truth. The URL becomes a serialization of the chain, not its source. Miller columns is unchanged as the renderer — it reads from the chain instead of computing from URL matching.

## Design

### Core concept

Replace `parent` with `after` — a list of valid predecessors. `after` serves dual duty:

1. **URL parsing:** disambiguates how to decompose a URL into pane segments
2. **Automatic placement:** when opening a pane, the system determines whether it goes left or right based on which chain entries declare the new pane in their `after`

### Placement algorithm

When inserting pane X into the current chain, find all valid positions, pick the **rightmost** one.

Position `i` is valid when:
- **X's left is valid:** `chain[i-1].paneId` is in `X.after` (or `null ∈ X.after` for position 0)
- **X's right is valid:** `X` is in `chain[i].after` (or `i == chain.length` for appending)

This means:
- Panes that can only follow existing chain members → append to the right (today's behavior)
- Panes that are declared as a predecessor of existing chain members → inserted to their left
- Invalid compositions → rejected (no valid position)

### URL encoding

URL = concatenation of pane segments in chain order. Greedy left-to-right parsing using `after` constraints reconstructs the chain from a URL.

## Implementation

### Step 1: Add `after` + `segment` to `Pane.define` (backward-compatible)

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

Add new fields to `DefineArgs` alongside existing `parent`/`path`:

```ts
interface DefineArgs<Path extends string, Provides, ParentParams> {
  id: string;
  // NEW — replaces parent
  after?: Array<PaneObject<any, any, any> | null>;
  segment?: Path;
  // KEPT for backward compat during migration
  parent?: PaneObject<ParentParams, any, any>;
  path?: Path;
  // ...unchanged
}
```

Add to `PaneInternal`:

```ts
interface PaneInternal {
  // NEW
  after: Set<string | null>;  // pane IDs or null (root)
  segment: string;            // own URL fragment
  // KEPT during migration
  parent: PaneInternal | null;
  ownPath: string;
  fullPath: string;
  // ...unchanged
}
```

**Backward-compat sugar in `define()`:** When `parent` is provided but `after` is not:
- `after = new Set([parent._internal.id])`
- `segment = path ?? ""`

When neither `parent` nor `after` is provided:
- `after = new Set([null])` (root pane)

When `after` is provided:
- `after = new Set(args.after.map(p => p?._internal.id ?? null))`
- `segment = args.segment ?? args.path ?? ""`

Runtime assertion: `after` and `parent` are mutually exclusive (dev-mode error).

### Step 2: Implement URL parser (`parseUrl`)

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

New function alongside existing `matchRegistry`:

```ts
function matchSegment(
  segment: string,
  remaining: string,
): { params: Record<string, string>; consumed: number } | null
```

Uses the same segment-matching logic as `matchPath` but operates on a prefix of the remaining URL. Returns how many characters were consumed.

```ts
function parseUrl(pathname: string): PaneSlot[] | null
```

Greedy left-to-right algorithm:
1. Normalize pathname (strip trailing slash)
2. Start with `predecessorId = null` (looking for root candidates)
3. Loop: for each pane in registry whose `after` contains `predecessorId`, try `matchSegment` against remaining URL
4. Pick longest match, record `{ paneId, params }`, advance cursor, set `predecessorId = matched pane id`
5. Repeat until URL consumed or no match

Special cases:
- Root URL `/`: match panes with segment `"/"` or `""` that have `null` in `after`
- Multi-segment segments like `debug/db-backup`: `matchSegment` handles them naturally (consumes multiple URL segments)
- Wildcard `:rest*`: consumes everything remaining

### Step 3: Implement URL builder (`buildChainUrl`)

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

```ts
function buildChainUrl(chain: PaneSlot[]): string
```

For each slot in the chain:
1. Look up pane in registry by `slot.paneId`
2. Render the pane's `segment` by substituting `:param` → `encodeURIComponent(slot.params[param])`
3. Concatenate all rendered segments with `/`

### Step 4: Implement `LayoutChain` store

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

Module-level reactive store using the same pattern as Miller's collapse/width hooks (module-level variable + subscriber set + `useEffect`-based hook):

```ts
type PaneSlot = { paneId: string; params: Record<string, string> }

let currentChain: PaneSlot[] = [];
const chainSubscribers = new Set<() => void>();

function getChain(): PaneSlot[] { return currentChain; }

function setChain(chain: PaneSlot[], replace = false): void {
  currentChain = chain;
  const url = buildChainUrl(chain);
  navigate(url, replace);
  for (const fn of chainSubscribers) fn();
}

function useChain(): PaneSlot[] {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const cb = () => forceUpdate(n => n + 1);
    chainSubscribers.add(cb);
    return () => { chainSubscribers.delete(cb); };
  }, []);
  return currentChain;
}
```

**Sync from URL:** When the pathname changes (popstate, shell:navigate), parse the URL into a chain and update the store (skipping the navigate call to avoid loops):

```ts
function syncChainFromUrl(pathname: string): void {
  const parsed = parseUrl(pathname);
  if (!parsed) { currentChain = []; return; }
  // Compare with currentChain to avoid unnecessary subscriber notifications
  if (chainsEqual(currentChain, parsed)) return;
  currentChain = parsed;
  for (const fn of chainSubscribers) fn();
}
```

### Step 5: Rewrite `pane.open()` with auto-placement

**File:** `plugins/primitives/plugins/pane/web/pane.ts` — inside `makePaneObject`

New `open()` implementation:

```ts
function open(params: Record<string, string>): void {
  const chain = getChain();
  const ownParams = extractOwnParams(internal, params);

  // Find valid insertion positions
  const validPositions: number[] = [];
  for (let i = 0; i <= chain.length; i++) {
    const leftOk = i === 0
      ? internal.after.has(null)
      : internal.after.has(chain[i - 1]!.paneId);
    const rightOk = i === chain.length
      ? true
      : registry.get(chain[i]!.paneId)?.after.has(internal.id) ?? false;
    if (leftOk && rightOk) validPositions.push(i);
  }

  if (validPositions.length > 0) {
    // Insert at rightmost valid position
    const pos = validPositions[validPositions.length - 1]!;
    const newChain = [
      ...chain.slice(0, pos),
      { paneId: internal.id, params: ownParams },
      ...chain.slice(pos),
    ];
    // Validate remaining chain entries after insertion
    const validated = validateChain(newChain);
    const replace = internal.chrome.enabled && !internal.chrome.history;
    setChain(validated, replace);
  } else {
    // No valid position in current chain — build fresh chain from root to this pane
    const freshChain = buildFreshChain(internal, params);
    const replace = internal.chrome.enabled && !internal.chrome.history;
    setChain(freshChain, replace);
  }
}
```

**`buildFreshChain(target, params)`:** Walk the `after` graph backward to find a path from a root-capable pane to `target`. For each pane along the path, extract its params from the flat `params` bag. This handles the case where `taskConversationPane.open({ taskId, convId })` is called from the welcome page — it needs to build `[tasksRoot, taskDetail(taskId), taskConversation(convId)]`.

Algorithm: BFS/DFS from `target` backwards through `after` edges until reaching a pane with `null` in its `after`. If the `after` graph is a DAG per-pane (common case: single predecessor), this is a simple linked-list walk. For multi-predecessor panes, pick the first path found.

**`validateChain(chain)`:** After insertion, verify each consecutive pair satisfies `after` constraints. Trim entries from the right that become invalid. This handles the case where inserting a pane breaks the constraint of the entry that was previously to its right.

**`extractOwnParams(pane, params)`:** Extract only the param keys that appear in this pane's `segment` (parse `:name` tokens from segment).

### Step 6: Rewrite `pane.close()`

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

```ts
function close(): void {
  const chain = getChain();
  const idx = chain.findIndex(s => s.paneId === internal.id);
  if (idx < 0) return;
  // Remove this pane and everything to its right
  const newChain = chain.slice(0, idx);
  const replace = internal.chrome.enabled && !internal.chrome.history;
  setChain(newChain, replace);
}
```

Note: with repeated pane IDs, `findIndex` returns the first occurrence. For positional awareness, `close()` should use `PaneDepthContext` when called from within a rendered column. However, `close()` is also called from event handlers outside React (e.g., pane-chrome's × button click). The chrome component has access to depth via context, so pass it through.

**Refined approach:** Add an optional `depth` parameter to the internal close, and have `PaneChrome` pass it:

```ts
// In makePaneObject:
function close(depth?: number): void {
  const chain = getChain();
  const idx = depth ?? chain.findIndex(s => s.paneId === internal.id);
  if (idx < 0) return;
  const newChain = chain.slice(0, idx);
  const replace = internal.chrome.enabled && !internal.chrome.history;
  setChain(newChain, replace);
}
```

### Step 7: Rewrite `pane.expand()`

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

```ts
function expand(): void {
  const chain = getChain();
  const idx = chain.findIndex(s => s.paneId === internal.id);
  if (idx < 0) return;
  // Accumulate fullParams from chain[0..idx]
  const fullParams: Record<string, string> = {};
  for (let i = 0; i <= idx; i++) {
    Object.assign(fullParams, chain[i]!.params);
  }
  const target = internal.chrome.expand?.(fullParams);
  if (target) navigate(target);
}
```

### Step 8: Resolve chain to `MatchEntry[]`

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

New function that converts the chain store's `PaneSlot[]` into the `MatchEntry[]` format that Miller columns and `usePaneMatch()` consumers expect:

```ts
function resolveChain(chain: PaneSlot[]): PaneMatch | null {
  if (chain.length === 0) return null;
  const entries: MatchEntry[] = [];
  const accumulated: Record<string, string> = {};
  for (const slot of chain) {
    const pane = registry.get(slot.paneId);
    if (!pane) return null;
    Object.assign(accumulated, slot.params);
    entries.push({
      pane,
      params: { ...slot.params },
      fullParams: { ...accumulated },
    });
  }
  return { chain: entries };
}
```

Update `useMatchForPath` to use the new system:

```ts
export function useMatchForPath(pathname: string): PaneMatch | null {
  syncChainFromUrl(pathname);
  const chain = useChain();
  return useMemo(() => resolveChain(chain), [chain]);
}
```

### Step 9: Update Miller columns for positional providers

**File:** `plugins/layouts/plugins/miller/web/components/miller-columns.tsx`

Replace global `wrapInProviders` with per-column provider wrapping:

```tsx
export function MillerColumns() {
  useSyncPaneRegistry();
  const pathname = usePathname();
  const match = useMatchForPath(pathname);
  // ...scroll logic unchanged...

  if (!match) return null;

  const row = (
    <div ref={ref} className="flex h-full overflow-x-auto">
      {match.chain.map((entry, i) => {
        let column = (
          <Column
            key={`${entry.pane.id}-${i}`}
            entry={entry}
            depth={i}
            isLast={i === match.chain.length - 1}
          />
        );
        // Wrap with providers from chain[0..i], innermost (i) wraps closest
        for (let j = i; j >= 0; j--) {
          const chainEntry = match.chain[j]!;
          const Provide = chainEntry.pane.provide;
          if (Provide) {
            column = (
              <PaneDepthContext.Provider value={j}>
                <Provide>{column}</Provide>
              </PaneDepthContext.Provider>
            );
          }
        }
        return column;
      })}
    </div>
  );

  return (
    <PaneMatchContext.Provider value={match}>
      <PluginErrorBoundary slot="layouts.miller" label={pathname}>
        {row}
      </PluginErrorBoundary>
    </PaneMatchContext.Provider>
  );
}
```

**Why `PaneDepthContext` inside provider wrapping:** A `provide` component (like `ConversationPaneProvide`) calls `conversationPane.useParams()` to know which entity to load. `useParams()` needs to find the right chain entry. With repeated pane IDs, it must use depth to disambiguate. Setting `PaneDepthContext` at each provider level ensures the correct `chain[j].params` is read.

**Column key:** Change from `key={entry.pane.id}` to `key={`${entry.pane.id}-${i}`}` (or just `key={i}`) to handle repeated pane IDs.

### Step 10: Update `useParams()` for positional awareness

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

```ts
function useParams(): Record<string, string> {
  const match = useContext(PaneMatchContext);
  const depth = useContext(PaneDepthContext);
  if (!match) throw new Error(`...called outside <PaneRouter/>.`);

  // Prefer depth-based lookup (works for repeated pane IDs)
  if (depth >= 0 && match.chain[depth]?.pane === internal) {
    return match.chain[depth]!.params;
  }
  // Fallback: find by identity (for non-column contexts)
  const entry = match.chain.find((e) => e.pane === internal);
  if (!entry) throw new Error(`...pane not in current match chain.`);
  return entry.params;
}
```

### Step 11: Update `pane-chrome.tsx` showClose logic

**File:** `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`

Replace `pane._internal.parent != null` with a depth check:

```tsx
const depth = useContext(PaneDepthContext);
const showClose = chrome.close && depth > 0;
```

A pane at position 0 in the chain has no meaningful "close" destination. Panes at position > 0 can close (remove themselves and everything to their right).

### Step 12: Migrate all pane definitions

Every `Pane.define` call migrates from `parent`/`path` to `after`/`segment`. The backward-compat sugar means this can be done incrementally, but a single batch migration is cleaner.

**Root panes** — add `after: [null]`, rename `path` to `segment` (strip leading `/`):

| Pane | Current `path` | New `segment` | `after` |
|------|---------------|---------------|---------|
| `welcome` | `/` | `/` | `[null]` |
| `conversation` | `/c/:convId` | `c/:convId` | `[null, attemptPane, taskDetailPane]` |
| `tasks-root` | `/tasks` | `tasks` | `[null]` |
| `agents-root` | `/agents` | `agents` | `[null]` |
| `attempt` | `/a/:attemptId` | `a/:attemptId` | `[null]` |
| `stats` | `/stats` | `stats` | `[null]` |
| `settings` | `/settings` | `settings` | `[null]` |
| `accounts` | `/accounts` | `accounts` | `[null]` |
| `global-file-tree` | `/code/:worktree` | `code/:worktree` | `[null]` |
| `screenshot` | `/screenshot/:id` | `screenshot/:id` | `[null]` |
| `publish` | `/publish` | `publish` | `[null]` |
| `logs` | `/logs` | `logs` | `[null]` |
| `recovery` | `/recovery` | `recovery` | `[null]` |
| `events-test` | `/events-test` | `events-test` | `[null]` |
| `db-backup` | `/debug/db-backup` | `debug/db-backup` | `[null]` |
| `queue` | `/debug/queue` | `debug/queue` | `[null]` |
| `worktree-cleanup` | `/debug/worktree-cleanup` | `debug/worktree-cleanup` | `[null]` |
| `debug-memory` | `/debug/memory` | `debug/memory` | `[null]` |
| `claude-cli-calls` | `/debug/claude-cli-calls` | `debug/claude-cli-calls` | `[null]` |

**Child panes** — replace `parent: X` with `after: [X]`:

All 14 conversation children, task children, agent children, etc. The `segment` field is the same as the current `path` (already relative).

**Special: `conversation` pane gets multi-predecessor `after`:**

```ts
// Today: after: [null] (root only)
// After: also reachable from attempt-view and task-detail
after: [null, attemptPane, taskDetailPane]
```

This is what enables `/a/123/c/456` (attempt on left, conversation on right). The URL parser sees `a/:attemptId` matches attempt, then `c/:convId` matches conversation (which lists attempt in its `after`).

**Note on `attemptConversationPane` and `taskConversationPane`:** Today these are separate pane IDs with `parent: attemptPane`/`parent: taskDetailPane` that wrap `ConversationView`. Under the new model, `conversationPane` itself lists both as predecessors, making the wrapper panes unnecessary. This is a follow-up simplification — for the initial migration, keep the wrapper panes with `after: [attemptPane]`/`after: [taskDetailPane]` respectively.

### Step 13: Update `usePaneMatch` toggle pattern

The toggle pattern (`match?.chain.some(e => e.pane === targetPane._internal)`) continues to work unchanged. The chain still contains `MatchEntry` objects with `pane: PaneInternal` references.

With repeated pane IDs, `chain.some(e => e.pane === X._internal)` returns true if ANY instance of X is in the chain. This is correct for toggle buttons ("is there a terminal pane somewhere?").

### Step 14: Remove backward compat (follow-up)

Once all pane definitions use `after`/`segment`:
- Remove `parent`, `path`, `ownPath`, `fullPath` from `PaneInternal` and `DefineArgs`
- Remove `matchRegistry`, `buildUrl`, `joinPath`
- Remove the sugar in `define()` that generates `after` from `parent`
- Update `pane.path` on `PaneObject` (currently exposes `fullPath`) — either remove or compute dynamically

## Key files

| File | Changes |
|------|---------|
| `plugins/primitives/plugins/pane/web/pane.ts` | Core rewrite: `after`/`segment` on DefineArgs, chain store, URL parser/builder, open/close/expand, useParams depth-awareness |
| `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` | Per-column provider wrapping, key prop fix |
| `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` | `showClose` uses depth instead of parent |
| 22 files with `Pane.define` calls | Migrate `parent`/`path` → `after`/`segment` |
| ~45 `pane.open()` call sites | No changes needed (flat params bag still accepted) |
| ~14 `pane.close()` call sites | No changes needed |

## Verification

After implementation, verify every URL pattern produces the same layout as before:

1. Root panes: `/`, `/tasks`, `/agents`, `/stats`, `/settings`, `/accounts`, `/publish`, etc.
2. Two-column chains: `/tasks/:taskId`, `/agents/:id`, `/a/:attemptId`, `/c/:convId`
3. Three-column chains: `/tasks/:taskId/c/:convId`, `/agents/:id/c/:convId`, `/a/:attemptId/c/:convId`
4. Conversation side panes: `/c/:convId/terminal`, `/c/:convId/tasks`, `/c/:convId/docs`, `/c/:convId/review`, `/c/:convId/files`, `/c/:convId/summary`, `/c/:convId/commits`, `/c/:convId/commits/:sha`
5. Side entity panes: `/c/:convId/c/:sideConvId`, `/c/:convId/task/:taskId`, `/c/:convId/agent/:agentId`
6. File peek: `/c/:convId/file/:worktree/:filePath*`, `/tasks/:taskId/file/:filePath*`

For each: verify columns render, toggle buttons work (open + close), close button navigates correctly, expand button navigates correctly.

Then test the new capability: opening attempt-view to the left of a conversation.

Deploy via `./equin build` and verify at `http://<worktree>.localhost:9000`.
