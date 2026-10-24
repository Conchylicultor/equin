# Drain the statement-form `no-pending-data-collapse` BURNDOWN allowlist

## Context

On 2026-06-12 the `live-state/no-pending-data-collapse` lint rule was extended
to also catch the early-return statement form `if (x.pending) return <typed-empty>`
(previously it only flagged the ternary `x.pending ? <empty> : x.data`). See
`research/2026-06-12-global-loading-pending-collapse-statement-form.md` for that
work. The reference case (`useEditedFiles`) was migrated, but six value-producing
holdouts were grandfathered into the per-rule allowlist at
`plugins/primitives/plugins/live-state/lint/index.ts`:

```
plugins/config_v2/plugins/settings/web/internal/use-conflicts.ts
plugins/config_v2/plugins/settings/web/internal/use-tiers.ts
plugins/config_v2/web/internal/use-scope-forked.ts
plugins/tasks/plugins/task-events/web/components/task-events.tsx        (two sites)
plugins/tasks/plugins/task-list/plugins/recent/web/internal/tasks-recent-view.tsx
plugins/apps/plugins/story/plugins/marker/web/hooks.ts
```

Each collapses its loading state into a fake-empty value (`{}`, `[]`, `false`)
before returning, so downstream callers can't tell "still loading" from
"genuinely empty" — the wrong-state-while-loading bug class. This plan migrates
all six to gateable shapes and empties the allowlist so the statement-form wave
is complete (matching the already-complete ternary wave).

Key facts established during exploration:
- Only `configV2Resource` is boot-hydrated; **conflicts / tiers / scope-forked
  render pending on first paint**, so the collapse genuinely manifests.
- `configV2ScopeForkedResource` has `initialData { forked: false }`, so a
  `select`-derived boolean read flips reliably (no `gate: true` needed).
- `useStories` has exactly **one** caller (`story-editor.tsx`); the story
  gallery already gates `storiesResource` directly via `useCombinedResources`.
  `useIsStory` has **zero** callers and is **not** flagged (its test is a
  logical-OR, not a bare `.pending`) — leave it untouched.
- `TasksRecentView` already early-returns `<Loading/>` after the collapsing
  memo — the memo collapse is pure redundancy.

## Sanctioned patterns reused

- `ResourceResult<T>` raw return + caller gate — the `useEditedFiles` /
  `useHasActiveSiblings` precedent (`plugins/primitives/plugins/live-state/web`).
- `useCombinedResources({ … })` + `if (all.pending) return <Loading/>` —
  all-or-nothing multi-resource gate.
- `matchResource(res, { ready, pending })` — expression-position gate.
- `useResource(res, params, { select })` — sanctioned point/derived read
  (rule carve-out) when false/empty-while-pending is the *correct* value.

---

## Migrations

### 1. `config_v2` hooks

**`use-conflicts.ts`** — return the raw result (drop the collapse):
```ts
export function useConflicts(): ResourceResult<ConfigV2Conflicts> {
  return useResource(configV2ConflictsResource);
}
```

**`use-tiers.ts`** — same:
```ts
export function useTiers(storePath: string): ResourceResult<ConfigV2Tiers> {
  return useResource(configV2TiersResource, { path: storePath });
}
```

**`use-scope-forked.ts`** — `select` carve-out, **keep the `boolean` API**
(zero caller changes). `false`-while-pending is the documented-correct fallback
(`useConfig` falls back to the global value while a scoped read loads), so this
is an honest point read, not a hidden collapse:
```ts
export function useScopeForked(scopeId?: string): boolean {
  const select = useCallback((d: ConfigV2ScopeForked) => d.forked, []);
  const result = useResource(
    configV2ScopeForkedResource,
    { scopeId: scopeId ?? "" },
    { select },
  );
  if (!scopeId) return false;
  if (result.pending) return false;
  return result.data; // now `boolean` (the selected slice)
}
```
`use-config.ts`, `theme-toggle.tsx`, `theme-injector.tsx`,
`theme-customizer.tsx` consume the unchanged `boolean` — no edits.

### 2. `useConflicts` callers (now `ResourceResult`)

**`config-sidebar-button.tsx`** — plain narrowing (dot stays hidden until
settled; never flashes on):
```ts
const conflicts = useConflicts();
const hasConflicts = !conflicts.pending && Object.keys(conflicts.data).length > 0;
```

**`use-config-row-state.ts`** — plain narrowing:
```ts
const conflictsRes = useConflicts();
const hasConflict = !conflictsRes.pending && registration.storePath in conflictsRes.data;
```

**`config-detail.tsx`** — **component split + `useCombinedResources` gate**
(chosen approach). `ConfigDetailInner` becomes a thin gate; the existing body
moves into a new `ConfigDetailBody` that receives settled `conflicts`/`tiers`
as plain props — so no flash of wrong tier badges or a missing conflict banner:
```ts
function ConfigDetailInner({ registration }: { registration: … }) {
  const conflictsRes = useConflicts();
  const tiersRes = useTiers(registration.storePath);
  const gated = useCombinedResources({ conflicts: conflictsRes, tiers: tiersRes });
  if (gated.pending) return <Loading />;
  return (
    <ConfigDetailBody
      registration={registration}
      conflicts={gated.data.conflicts}
      tiers={gated.data.tiers}
    />
  );
}
```
`ConfigDetailBody` holds today's `ConfigDetailInner` logic verbatim
(`useConfig`, `valueFor`, `isSoftConflict`, `hasAnyModified`, the two
`useEndpointMutation`s, `useEffect`, the full render), reading `conflicts`/
`tiers` from props instead of the hooks. `const conflictEntry =
conflicts[registration.storePath];` and `tier={tiers[key]}` now operate on
settled data. Trade-off: a brief full-pane `<Loading/>` on first open instead
of fields-then-badges-popping — the standard, more-correct gate.

### 3. `task-events.tsx` (two sites)

Combine both resources, gate once, compute after the gate (delete the two
collapsing `useMemo`s). All hooks run before the early return:
```ts
const attemptsQ = useResource(attemptsResource);
const pushesQ = useResource(pushesResource);
const githubBase = useGithubBase();
const openPane = useOpenPane();
const convEntries = conversationPane.useRouteEntries();
const all = useCombinedResources({ attempts: attemptsQ, pushes: pushesQ });
const activeConvEntry = convEntries.length > 1 ? convEntries.at(-1)! : null;
const activeConvId = activeConvEntry?.params.convId;

if (all.pending) return <Loading variant="rows" />;

const attempts = all.data.attempts
  .filter((a) => a.taskId === taskId)
  .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
const attemptIds = new Set(attempts.map((a) => a.id));
const pushes = all.data.pushes
  .filter((p) => attemptIds.has(p.attemptId))
  .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
return ( … );
```
Add the `Loading` import. The "No pushes yet." / "No attempts yet." empties now
show only on confirmed-empty.

### 4. `tasks-recent-view.tsx`

The component already gates with `<Loading variant="rows" />` — just delete the
redundant memo collapse and compute after the gate (drops `useMemo` +
`useCallback`; `useResource` and `useState` still run before the gate):
```ts
const result = useResource(tasksResource);
const [hideTerminal, setHideTerminal] = useState(true);

if (result.pending) return <Loading variant="rows" />;

const sorted = [...result.data]
  .filter((t) => !hideTerminal || !isTerminal(t.status))
  .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
return ( … );
```

### 5. `story/marker/web/hooks.ts` — `useStories`

Return the raw result on pending, map only the settled data (returning the
whole `result` on pending is **not** flagged and yields a proper gateable
whole-resource `ResourceResult`):
```ts
export function useStories(): ResourceResult<StoryMark[]> {
  const result = useResource(storiesResource);
  if (result.pending) return result;
  return { ...result, data: Object.values(result.data) };
}
```
Update the function's doc comment (drop the "returns `[]` while pending —
consumers must gate themselves" warning; it now returns a gateable result).
Leave `useIsStory` as-is (unused + unflagged).

**`story-editor.tsx`** caller — `matchResource` (tolerates null-while-pending,
which the file already documents):
```ts
const storiesRes = useStories();
const defaultRendererId = matchResource(storiesRes, {
  ready: (marks) => marks.find((m) => m.pageId === pageId)?.defaultRendererId ?? null,
  pending: () => null,
});
```

### 6. `lint/index.ts` — empty the allowlist

Set `"no-pending-data-collapse": []` and revise the comment to mark the
statement-form wave **COMPLETE** (mirroring the ternary wave), keeping the
"MIGRATE entries, never add" guidance.

## Critical files

| File | Change |
|---|---|
| `plugins/config_v2/plugins/settings/web/internal/use-conflicts.ts` | return `ResourceResult<ConfigV2Conflicts>` |
| `plugins/config_v2/plugins/settings/web/internal/use-tiers.ts` | return `ResourceResult<ConfigV2Tiers>` |
| `plugins/config_v2/web/internal/use-scope-forked.ts` | `select` carve-out, keep `boolean` API |
| `plugins/config_v2/plugins/settings/web/components/config-sidebar-button.tsx` | narrow `!pending && …` |
| `plugins/config_v2/plugins/settings/web/internal/use-config-row-state.ts` | narrow `!pending && …` |
| `plugins/config_v2/plugins/settings/web/components/config-detail.tsx` | split `ConfigDetailInner` gate + `ConfigDetailBody` |
| `plugins/tasks/plugins/task-events/web/components/task-events.tsx` | `useCombinedResources` gate + compute after; import `Loading` |
| `plugins/tasks/plugins/task-list/plugins/recent/web/internal/tasks-recent-view.tsx` | drop redundant memo collapse |
| `plugins/apps/plugins/story/plugins/marker/web/hooks.ts` | `useStories` returns gateable result + doc update |
| `plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx` | `matchResource` caller |
| `plugins/primitives/plugins/live-state/lint/index.ts` | empty allowlist + comment |

## Verification

1. `./equin build` — green `type-check`, `eslint`, `plugins-doc-in-sync`,
   boundaries. The extended rule must flag **nothing** with the empty allowlist.
2. `./equin check eslint` — confirm `no-pending-data-collapse` passes with
   zero violations (the drain is complete).
3. Sanity guard: temporarily re-add one collapse (e.g. `if (r.pending) return {}`)
   in any migrated file → `./equin check eslint` fails → revert.
4. App spot-checks at `http://<worktree>.localhost:9000`:
   - **Config detail** (Settings → Config → any entry): brief `<Loading/>` then
     fields with correct tier badges; conflict banner never flashes absent on a
     conflicted entry.
   - **Config sidebar** warning dot appears once conflicts settle (never a
     transient flash-off).
   - **Task detail → Events** section: `<Loading rows>` then pushes/attempts;
     "No pushes/attempts yet." only on a genuinely empty task.
   - **Recent tasks** tab: skeleton then rows, no empty flash.
   - **Story editor**: opening a story restores the persisted renderer lens (no
     spurious reset of `defaultRendererId`).
5. **Theme toggle / customizer** (useScopeForked consumers): forking an app
   scope still routes edits to the scoped layer; light/dark toggle unaffected.
