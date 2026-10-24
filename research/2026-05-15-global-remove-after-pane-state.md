# Remove `after:` from panes — chain-first pane system

## Context

The pane system currently couples three concerns:

1. **Structural constraints** (`after:`) — declares which panes must appear before this one in the chain
2. **URL routing** — the URL is the source of truth; `parseUrl()` walks segments and uses `after:` to disambiguate
3. **Ancestor data coupling** (`useData()`) — panes depend on ancestor panes being alive to provide loaded data

This coupling makes the mental model harder than it needs to be. A pane author must think about URL segment parsing, ancestor constraints, data providers, and chain validation — when all they want is "show this component with this state in a column."

**Goals:**
- Make the chain store the sole runtime source of truth (URL is derived)
- Remove `after:` — panes have no structural ordering constraints
- Panes receive input data on creation, persisted in their slot — self-contained, no ancestor dependency
- Phase out `provides`/`useData()` in favor of `input` + self-fetching

## Design

### Core principle: chain-first, URL-derived

```
Before:  URL → parseUrl() → chain → render
         pane reads ancestor data via useData()

After:   chain → render
                → deriveUrl() → URL (cosmetic, for deep linking)
         pane reads own input + self-fetches what it needs
```

### 1. Add `input` to panes — self-contained state

`PaneSlot` gains an `input` field for non-URL state passed at creation time:

```ts
interface PaneSlot {
  instanceId: number;
  paneId: string;
  params: Record<string, string>;   // from URL segment (:param)
  input: Record<string, string>;    // caller-provided, persisted in slot
}
```

Panes declare their input type:

```ts
const filePeekPane = Pane.define({
  id: "file-peek",
  segment: "file/:worktree/:filePath*",
  input: type<{ convId: string }>(),
  component: FilePeek,
});
```

Callers pass input when opening:

```ts
openPane(filePeekPane,
  { worktree: conv.attemptId, filePath: "src/foo.ts" },
  { input: { convId: conv.id } },
);
```

Inside the component:

```ts
function FilePeek() {
  const { worktree, filePath } = filePeekPane.useParams();  // URL params
  const { convId } = filePeekPane.useInput();                // persisted input
  const conv = useConversation(convId);                       // self-fetch
}
```

**Key behaviors:**
- `input` is stored in the `PaneSlot` and serialized to `history.state`
- `input` is NOT in the URL — on cold page load from a shared link, input is `{}`
- On cold load, the pane falls back to reading ancestor params or self-fetching from its own URL params
- `input` survives back/forward navigation (stored in `history.state`)
- `input` survives the original opener pane being closed/removed

**Cold load fallback pattern:**

```ts
function FilePeek() {
  const { worktree, filePath } = filePeekPane.useParams();
  const input = filePeekPane.useInput();

  // Try input first (available when opened programmatically)
  // Fall back to ancestor params (available on cold load from URL)
  const convId = input.convId
    ?? conversationPane.useChainEntry()?.params.convId;

  const conv = convId ? useConversation(convId) : null;
}
```

### 2. Store chain in `history.state`

`setChain()` stores the full chain (including `input`) in `history.state`:

```ts
function setChain(chain: PaneSlot[], replace = false): void {
  currentChain = chain;
  notifyChainListeners();
  const url = buildChainUrl(chain);
  const serialized = chain.map(s => ({
    paneId: s.paneId,
    params: s.params,
    input: s.input,
  }));
  const fullUrl = applyBasePath(url);
  if (replace) {
    window.history.replaceState({ chain: serialized }, "", fullUrl);
  } else {
    window.history.pushState({ chain: serialized }, "", fullUrl);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.dispatchEvent(new CustomEvent("shell:navigate"));
}
```

The `popstate` handler prefers `history.state`:

```ts
function handleLocationChange(): void {
  const state = window.history.state;
  if (state?.chain) {
    restoreChainFromState(state.chain);  // includes input
  } else {
    syncChainFromUrl(stripBasePath(window.location.pathname, currentBasePath));
  }
}
```

- **Back/forward**: reads chain + input from `history.state`
- **Cold load / shared links**: falls back to `parseUrl()` (input is `{}`)
- **Runtime navigation**: always via `setChain()`, never from URL

### 3. Remove `after:` from `Pane.define`

Remove `after` from `DefineArgs`, `PaneInternal`, and all 48 call sites (35 files).

| Current use of `after:` | Replacement |
|---|---|
| URL parsing disambiguation | Make segments globally unique (§3a) |
| `isAfterSatisfied()` in `parseUrl()` | Remove — linear segment matching suffices |
| `validateChain()` | Remove — any ordering is valid |
| `findValidPositions()` | Remove — caller decides position |
| `buildFreshChain()` walking `after:` | `defaultAncestors` hint (§3b) |

#### 3a. Resolve segment collisions

Two segment pairs currently rely on `after:` for disambiguation:

| Collision | Pane A | Pane B | Fix |
|---|---|---|---|
| `a/:param` | `attemptPane` (root) | `agentDetailPane` (after agents) | Rename `agentDetailPane` → `ag/:id` |
| `tasks` | `tasksRootPane` (root) | `convTasksPane` (after conversation) | Rename `convTasksPane` → `tp` |

Files:
- `plugins/agents/web/panes.tsx` — segment `"a/:id"` → `"ag/:id"`
- `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/panes.tsx` — segment `"tasks"` → `"tp"`

#### 3b. `defaultAncestors` replaces `buildFreshChain`

When opening a pane from scratch (no caller context), `buildFreshChain` currently walks `after:` pointers to build ancestor chain. Replace with a declarative hint:

```ts
export const taskDetailPane = Pane.define({
  id: "task-detail",
  segment: "t/:taskId",
  defaultAncestors: [tasksRootPane],
  component: TaskDetail,
});
```

When `openPaneImpl` fires with no caller and no explicit ancestors, it reads `defaultAncestors` to prepend. Not a constraint — just a UX default.

Most panes just delete `after:`; only ~5-10 that are opened from sidebar navigation need `defaultAncestors`.

### 4. Simplify core functions

**Remove entirely:**
- `isAfterSatisfied()`
- `findValidPositions()`
- `validateChain()`
- `buildFreshChain()`

**Simplify `openPaneImpl`:**

```ts
function openPaneImpl(
  internal: PaneInternal,
  params: Record<string, string>,
  opts?: {
    root?: boolean;
    input?: Record<string, string>;
    ancestors?: Array<{ pane: PaneObject; params: Record<string, string> }>;
  },
): void {
  const replace = internal.chrome.enabled && !internal.chrome.history;
  const chain = getChain();
  const ownParams = extractOwnParams(internal, params);
  const input = opts?.input ?? {};

  if (!opts?.root) {
    const existingIdx = chain.findIndex((s) => s.paneId === internal.id);
    if (existingIdx >= 0) {
      // Already in chain — update params/input, truncate children
      const newChain = chain.slice(0, existingIdx + 1);
      newChain[existingIdx] = createSlot(internal.id, ownParams, input);
      setChain(newChain, replace);
      return;
    }
  }

  // Build fresh chain from defaultAncestors or explicit ancestors
  const ancestors = opts?.ancestors ?? internal.defaultAncestors ?? [];
  const ancestorSlots = ancestors.map(a =>
    createSlot(a.pane._internal.id, extractOwnParams(a.pane._internal, a.params))
  );
  setChain([...ancestorSlots, createSlot(internal.id, ownParams, input)], replace);
}
```

**Simplify `useOpenPane`** — same three modes (`push`/`swap`/`root`), drop all validation:

- `push right`: truncate after caller, append target with input
- `push left`: insert before caller
- `swap`: update params/input in-place
- `root`: delegate to `openPaneImpl`

**Simplify `parseUrl`** — remove `isAfterSatisfied` filter, match segments greedily left-to-right. Slots created by URL parsing have empty `input: {}`.

### 5. MillerColumns simplification

Drop `usePathname()` and pathname stripping. Read purely from chain store:

```tsx
export function MillerColumns() {
  const basePath = useContext(PaneBasePathContext);
  useMemo(() => { setBasePath(basePath); }, [basePath]);
  useSyncPaneRegistry();

  const match = useMatchForChain();  // reads chain, not URL

  if (!match) return null;
  return (
    <PaneMatchContext.Provider value={match}>
      {/* ... render columns */}
    </PaneMatchContext.Provider>
  );
}
```

### 6. Phase out `provides`/`useData()` → `input` + self-fetch

The `provides`/`provide`/`useData()` pattern is replaced incrementally:

**Current (37 call sites for `conversationPane.useData()`):**
```ts
const { conversation } = conversationPane.useData();
const attemptId = conversation.attemptId;  // needs loaded record
```

**New — two strategies depending on data type:**

| Data type | Strategy | Example |
|---|---|---|
| Static per-session (attemptId, taskId, worktreePath) | Pass as `input` at open time | `input: { attemptId: conv.attemptId }` |
| Live-updating (status, model, title) | Self-fetch via shared hook | `useConversation(convId)` — TanStack Query deduplicates |
| Only needs `conversation.id` | Read from own input or ancestor params | `input.convId ?? conversationPane.useChainEntry()?.params.convId` |

**Migration example — CommitsGraphBody (needs `attemptId`):**

```ts
// Before:
const { conversation } = conversationPane.useData();
// uses conversation.id, conversation.attemptId

// After:
const input = commitsGraphPane.useInput(); // { convId, attemptId }
const convId = input.convId
  ?? conversationPane.useChainEntry()?.params.convId;
// attemptId from input, convId for any self-fetching
```

**Caller passes input when opening:**
```ts
openPane(commitsGraphPane, {}, {
  input: { convId: conv.id, attemptId: conv.attemptId },
});
```

Once all 37 consumers are migrated, `provides`/`provide`/`useData()` can be removed. `useDataMaybe()` (8 call sites) follows the same pattern.

### 7. Update pane-restore

Read from chain store directly instead of parsing URL:

```ts
function handleNavigation(): void {
  const chain = getChain();
  if (chain.length === 0 || chain[0]?.paneId !== "conversation") return;
  const convId = chain[0]?.params.convId;
  if (!convId) return;
  saveChainForConversation(convId, chain.map(s => ({
    paneId: s.paneId,
    params: s.params,
    input: s.input,
  })));
}
```

## Implementation order

### PR 1: Chain-first foundation + remove `after:`
1. Add `input` field to `PaneSlot` + `createSlot()` + `useInput()` hook + `input: type<T>()` on `Pane.define`
2. Store chain (with input) in `history.state`
3. Update `popstate` handler to prefer `history.state`
4. Drop `usePathname()` from MillerColumns
5. Fix 2 segment collisions
6. Add `defaultAncestors` to `Pane.define`
7. Remove `after:` from all 48 declarations (35 files), add `defaultAncestors` where needed
8. Remove `isAfterSatisfied`, `validateChain`, `findValidPositions`, `buildFreshChain`
9. Simplify `openPaneImpl`, `useOpenPane`, `parseUrl`
10. Update pane-restore
11. Update CLAUDE.md docs

Note: `provides`/`useData()` continues working by chain position — no consumers need to change in this PR. The `input` infrastructure is available but not yet used by consumers.

### PR 2+: Migrate `useData()` consumers (incremental)
Migrate 37 `conversationPane.useData()` call sites → `useInput()` + self-fetch. Can be done per-plugin, one PR at a time:

- ~12 sites that only need `conversation.id` → read from `input.convId` or `conversationPane.useChainEntry()?.params.convId`
- ~20 sites that need `attemptId`/`taskId` → receive via `input`, self-fetch via `useConversation(convId)` for live fields
- ~5 sites that need live fields (`status`, `model`) → self-fetch via `useConversation(convId)`
- 8 `useDataMaybe()` sites → same pattern with null handling

### PR 3: Remove `provides`/`provide`/`useData()`
Once all consumers are migrated, delete:
- `provides`, `provide` fields from `Pane.define`
- `useData()`, `useDataMaybe()` hooks
- Provider wrapping loop in MillerColumns

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/pane/web/pane.ts` | Core: input field, history.state, remove after:, simplify openPaneImpl/useOpenPane/parseUrl, add defaultAncestors |
| `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` | Drop usePathname, chain-only matching |
| `plugins/conversations/plugins/pane-restore/web/internal/pane-restore-store.ts` | Read chain store, persist input |
| `plugins/agents/web/panes.tsx` | Rename segment, remove after:, add defaultAncestors |
| `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/panes.tsx` | Rename segment |
| 35 files with `after:` declarations | Remove after:, add defaultAncestors where needed |
| `plugins/primitives/plugins/pane/CLAUDE.md` | Rewrite for new mental model |
| `plugins/layouts/plugins/miller/CLAUDE.md` | Update |

## Verification

1. `./equin build` — full build passes
2. Navigate: sidebar → conversation → task detail → file peek → back/forward
3. Refresh on deep URL (`/c/abc123/t/task456`) — chain reconstructs from URL
4. Browser back/forward — chain restores from `history.state` (including input)
5. pane-restore: open conversation, navigate sub-panes, leave, return — chain restores
6. Open panes from sidebar (root mode) — ancestors appear via defaultAncestors
7. Promote a pane to root — pane works standalone with its persisted input
8. `./equin check` passes
