# PR3: Remove `provides`/`provide`/`useData()`/`useDataMaybe()`

## Context

PR1 established the chain-first pane architecture: `input`/`useInput()`, `defaultAncestors`, `history.state` as runtime source of truth. PR2 migrated all `conversationPane.useData()` consumers to `useInput()` + self-fetch. The `provides`/`provide`/`useData()` infrastructure is now dead weight — no external consumers remain.

This PR removes the infrastructure entirely, simplifying the pane primitive to its final form: panes are self-contained, receive `input` from callers, and self-fetch their data.

## Current state (verified)

- **`conversationPane`** — already has NO `provides:` (never did in the new architecture; data flows via slot props)
- **`taskDetailPane`** — has `provides:` + internal `.Provider` wrapping, but ZERO `useData()` callers remain
- **`agentDetailPane`** — same: `provides:` + internal `.Provider`, ZERO callers
- **`serverDetailPane`** — has `provides:` + internal `.Provider`, ONE caller: `server-detail.tsx:6`
- **`useDataMaybe()`** — ZERO call sites remain
- **`ConversationPaneProvide` / `ConversationProvide`** — do not exist in the codebase
- **`ActiveRelateSync`** — already lives inside `ConversationView`, no move needed

## Implementation

### Step 1: Migrate the last `useData()` consumer

**`plugins/apps/plugins/deploy/plugins/servers/web/components/server-detail.tsx`**

Change `ServerDetail` to accept `server: Server` as a prop instead of calling `serverDetailPane.useData()`:

```tsx
// Before:
export function ServerDetail() {
  const { server } = serverDetailPane.useData();

// After:
export function ServerDetail({ server }: { server: Server }) {
```

Remove the `serverDetailPane` import. Add `Server` import from `../../shared`.

**`plugins/apps/plugins/deploy/plugins/servers/web/panes.tsx`**

Pass `server` through the component chain:

```tsx
// ServerDetailBody: remove Provider wrapping
function ServerDetailBody() {
  // ... server loaded as before ...
  return (
    <PaneChrome pane={serverDetailPane} title={server.name}>
      <ServerDetailContent serverId={serverId} server={server} />
    </PaneChrome>
  );
}

// ServerDetailContent: accept and forward server prop
function ServerDetailContent({ serverId, server }: { serverId: string; server: Server }) {
  // ...
  <ServerDetail server={server} />
  // ...
}
```

Remove `provides: type<{ server: Server }>()` from `serverDetailPane` definition. Remove `type` import if unused.

### Step 2: Remove dead `.Provider` wrapping from other panes

**`plugins/tasks/plugins/task-detail/web/panes.tsx`**

Remove `provides: type<{ task: Task }>()` from `taskDetailPane` definition. Simplify `TaskDetailBody`:

```tsx
// Before:
if (!task) return wrapped;
return (
  <taskDetailPane.Provider value={{ task }}>{wrapped}</taskDetailPane.Provider>
);

// After:
return wrapped;
```

Remove unused imports: `type` from pane barrel, `Task` from tasks/core (if only used for `provides:`).

**`plugins/agents/web/panes.tsx`**

Remove `provides: type<{ agent: Agent }>()` from `agentDetailPane` definition. Simplify `AgentDetailBody`:

```tsx
// Before:
if (!agent) return wrapped;
return (
  <agentDetailPane.Provider value={{ agent }}>
    {wrapped}
  </agentDetailPane.Provider>
);

// After:
return wrapped;
```

Remove `type` import. Check if `Agent` import is still needed (used by `agentsResult.data.find((a: Agent) => ...)`).

### Step 3: Remove infrastructure from `pane.ts`

**`plugins/primitives/plugins/pane/web/pane.ts`**

a. **Remove from `PaneInternal`** (lines 101-122):
   - Delete `provide?: ComponentType<{ children: ReactNode }>` (line 119)
   - Delete `dataContext: ReturnType<typeof createContext<unknown>>` (line 120)
   - Delete the JSDoc block for `provide` (lines 111-118)

b. **Delete `DATA_NOT_PROVIDED`** (line 129)

c. **Simplify `PaneObject` interface** (lines 540-576):
   - Remove `Provides` generic parameter: `PaneObject<FullParams, Provides, OwnParams, Input>` → `PaneObject<FullParams, OwnParams, Input>`
   - Delete `Provider` member (line 547)
   - Delete `useData()` member (line 551)
   - Delete `useDataMaybe()` member (line 552)

d. **Simplify `makePaneObject`** (lines 578-777):
   - Delete `const { dataContext, actionsSlot } = internal;` → `const { actionsSlot } = internal;`
   - Delete `Provider` component (lines 581-587)
   - Delete `useData()` function (lines 638-646)
   - Delete `useDataMaybe()` function (lines 648-651)
   - Remove from returned `paneObject`: `Provider`, `useData`, `useDataMaybe` (lines 758, 761-762)

e. **Simplify `DefineArgs` interface** (lines 802-829):
   - Remove `Provides` generic parameter
   - Delete `provides?: TypeMarker<Provides>` (line 809)
   - Delete `provide?` field + JSDoc (lines 818-828)

f. **Simplify `define()` function** (lines 831-883):
   - Remove `Provides` generic parameter from signature
   - Delete `dataContext` creation (lines 857-858)
   - Delete `provide: args.provide` from internal (line 872)
   - Delete `dataContext` from internal (line 873)
   - Update return type: remove `Provides` position

g. **Update `PaneObject<any, any, any, any>` usages** within pane.ts to `PaneObject<any, any, any>` (3 params after `Provides` removal).

### Step 4: Simplify MillerColumns

**`plugins/layouts/plugins/miller/web/components/miller-columns.tsx`**

Replace the provider wrapping loop (lines 48-60) with simple `PaneInstanceContext` wrapping:

```tsx
{match.chain.map((entry, i) => (
  <Fragment key={entry.instanceId}>
    <PaneInstanceContext.Provider value={entry.instanceId}>
      <Column entry={entry} isLast={i === match.chain.length - 1} />
    </PaneInstanceContext.Provider>
  </Fragment>
))}
```

### Step 5: Update CLAUDE.md docs

**`plugins/primitives/plugins/pane/CLAUDE.md`**

- Remove from opening paragraph: "Ancestor data flows to descendants via typed `provides` / `provide` / `useData()`."
- Remove `provides:` from the `Pane.define` example (line ~27)
- Remove `provide` from the rules list under "Define a pane"
- Remove the entire **"Provide data"** section (~lines 128-175)
- Remove the forward-looking note at ~lines 206-210 about `input` replacing `provides`/`useData()`
- Update the `TaskDetailBody` example in the "Chrome" section to not use `useData()`
- Remove `useData()` from the "Read params and ancestor data" section title and examples

**`plugins/layouts/plugins/miller/CLAUDE.md`**

- Remove any references to `provide` wrapping (the provider loop is gone)

## Files changed

| File | Change |
|---|---|
| `plugins/primitives/plugins/pane/web/pane.ts` | Remove `provides`/`provide`/`Provider`/`useData`/`useDataMaybe`/`dataContext`/`DATA_NOT_PROVIDED` from interfaces, implementations, and factory |
| `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` | Replace provider wrapping loop with simple `PaneInstanceContext` wrap |
| `plugins/apps/plugins/deploy/plugins/servers/web/panes.tsx` | Remove `provides:`, remove Provider wrapping, pass `server` as prop |
| `plugins/apps/plugins/deploy/plugins/servers/web/components/server-detail.tsx` | Accept `server` prop instead of `serverDetailPane.useData()` |
| `plugins/tasks/plugins/task-detail/web/panes.tsx` | Remove `provides:`, remove Provider wrapping |
| `plugins/agents/web/panes.tsx` | Remove `provides:`, remove Provider wrapping |
| `plugins/primitives/plugins/pane/CLAUDE.md` | Remove "Provide data" section and all `provides`/`useData` references |
| `plugins/layouts/plugins/miller/CLAUDE.md` | Remove `provide` wrapping references |

## Verification

1. `./equin build` — full build passes (TypeScript + ESLint)
2. Navigate: sidebar → conversation → task detail → file peek → back/forward
3. Open server detail pane — verify server info renders correctly
4. Open agent detail pane — verify agent info renders
5. Open task detail pane — verify task info renders, sections load
6. Refresh on a deep URL — chain reconstructs from URL parsing (cold load)
7. Back/forward — chain restores from `history.state`
8. `./equin check` passes
9. Grep verification: `rg 'useData|provides:|provide:|useDataMaybe|DATA_NOT_PROVIDED' -g '*.ts' -g '*.tsx' plugins/` returns zero hits (excluding comments/docs)
