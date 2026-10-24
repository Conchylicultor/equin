# Review pane: shared source selector — v2

## Context

v1 lifted the commit selector to the review pane and widened `ReviewProps` to include `source`. But `PluginChangesSection` punted on push mode with a "not available" placeholder. The user's feedback: the abstraction should be fully transparent — all sections should work for all source modes.

The `Source` type itself is already fine as a discriminated union. The gap is server-side: the plugin-changes endpoint only computes filesystem diffs (worktree dir vs main dir). It needs push-mode support using git-based diffing.

Key finding: `buildPluginTree` (used by `computePluginChanges`) is **purely static** — `readFileSync`, `readdirSync`, regex parsing, `Bun.Transpiler.transformSync`. No dynamic `import()`. So it works on any directory with raw `.ts` source files, including temp-extracted `git archive` output.

## Changes

### 1. Server: add push-mode to plugin-changes endpoint

**`plugins/review/plugins/plugin-changes/server/internal/handle-plugin-changes.ts`**

Accept optional `pushId` query param alongside `conversationId`. When `pushId` is present:

1. Resolve SHAs — reuse `listPushesByPushId` from `@plugins/tasks-core/server` and `resolveParentSha` from `@plugins/code-explorer/server/internal/get-push-files.ts`:
   ```
   commits = listPushesByPushId(pushId)
   baseSha = resolveParentSha(mainRoot, commits[0].sha)
   headSha = commits[commits.length - 1].sha
   ```

2. Get edited files via `getRangeFiles(mainRoot, baseSha, headSha)` from `@plugins/code-explorer/server/internal/get-push-files.ts`. (This is the same function the push endpoint uses.)

3. Extract plugin trees at both SHAs into temp dirs using `git archive`:
   ```
   git archive <baseSha> -- plugins/ | tar -x -C /tmp/review-base-<id>/
   git archive <headSha> -- plugins/ | tar -x -C /tmp/review-head-<id>/
   ```

4. Call `computePluginChanges(headPluginsDir, basePluginsDir, editedFiles)` — same function, just with temp dirs instead of live worktree/main dirs.

5. Clean up temp dirs in a `finally` block.

Note: `resolveParentSha` and `getRangeFiles` are currently not exported from the `code-explorer` server barrel. Two options:
- **(a)** Export them from `@plugins/code-explorer/server` — they're general git utilities
- **(b)** Inline the logic (it's ~10 lines of `git rev-parse` + `git diff`) to avoid a cross-plugin dependency

Prefer **(a)** — these are reusable git utilities. Add them to the `code-explorer` server barrel.

### 2. Web: pass `source` through to `usePluginChanges`

**`plugins/review/plugins/plugin-changes/web/use-plugin-changes.ts`**

Accept `source: Source` and append `pushId` to the query when in push mode:

```ts
export function usePluginChanges(conversationId: string, source: Source) {
  const pushId = source.kind === "push" ? source.pushId : undefined;
  return useQuery<PluginChangesResponse>({
    queryKey: ["review", "plugin-changes", conversationId, pushId],
    queryFn: async () => {
      const params = new URLSearchParams({ conversationId });
      if (pushId) params.set("pushId", pushId);
      const res = await fetch(`/api/review/plugin-changes?${params}`);
      ...
    },
  });
}
```

### 3. Web: remove placeholder from `PluginChangesSection`

**`plugins/review/plugins/plugin-changes/web/components/plugin-changes-section.tsx`**

Remove the `source.kind === "push"` early return / placeholder. Collapse back to a single component (undo the wrapper/inner split from v1). Pass `source` through to `usePluginChanges`:

```tsx
export function PluginChangesSection({ conversationId, source }: { conversationId: string; source: Source }) {
  const { data, isPending, error } = usePluginChanges(conversationId, source);
  // ... existing rendering, unchanged
}
```

### 4. Export `resolveParentSha` and `getRangeFiles` from code-explorer

**`plugins/code-explorer/server/index.ts`**

Add re-exports so plugin-changes can import them without reaching into internal paths:
```ts
export { resolveParentSha, getRangeFiles } from "./internal/get-push-files";
```

## Files to modify

| File | Action |
|------|--------|
| `plugins/code-explorer/server/index.ts` | Edit — export `resolveParentSha`, `getRangeFiles` |
| `plugins/review/plugins/plugin-changes/server/internal/handle-plugin-changes.ts` | Edit — add push-mode branch |
| `plugins/review/plugins/plugin-changes/web/use-plugin-changes.ts` | Edit — accept `source`, pass `pushId` |
| `plugins/review/plugins/plugin-changes/web/components/plugin-changes-section.tsx` | Edit — remove placeholder, pass source to hook |

No changes to `Source` type, `ReviewProps`, `panes.tsx`, `slots.ts`, or `review-button.tsx` — v1's abstraction holds.

## Verification

1. `./equin build` — clean compile
2. Open review pane for a conversation with pushes
3. Switch to a push tab — **both** code-review and plugin-changes update (no placeholder)
4. Plugin-changes shows the structural diff (slots, exports, contributions) scoped to that push's commit range
5. Switch back to "Working tree" — both sections show working-tree state
6. `./equin check` — no boundary or lint violations
