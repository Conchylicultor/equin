# File Resolve Plugin

## Context

Clicking a file link like `task-detail/panes.tsx` in a task description or conversation transcript shows "File not found" because the path is passed verbatim to `GET /api/code/:worktree/file?path=task-detail/panes.tsx`. The server joins it to the worktree root, but the real file lives at `plugins/tasks/plugins/task-detail/web/panes.tsx`. There is no fuzzy resolution — just a direct `Bun.file(absTarget).exists()` check.

## Design

New sub-plugin `plugins/code-explorer/plugins/file-resolve/` with a server endpoint and a client hook+component. The two existing file-peek pane bodies integrate via a thin resolution layer.

### Server: `GET /api/code/:worktree/resolve?path=<partial>`

Response:
```ts
| { kind: "exact" }                          // path exists as-is
| { kind: "resolved", matches: string[] }    // 1+ suffix matches found  
| { kind: "not-found" }                      // nothing matched
```

Algorithm:
1. Validate input (non-empty, no null bytes)
2. Check if the exact path exists on disk → `{ kind: "exact" }` (fast path, no git)
3. Run `git ls-files --cached --others --exclude-standard`
4. **Segment-subsequence match**: split the query into segments (`task-detail/panes.tsx` → `["task-detail", "panes.tsx"]`). A file matches when all query segments appear in order as a subsequence of the file's segments. This handles intervening directories (e.g. `web/` between `task-detail` and `panes.tsx`).
5. Return matches or not-found

The subsequence matcher:
```ts
function isSubsequence(query: string[], file: string[]): boolean {
  let qi = 0;
  for (let fi = 0; fi < file.length && qi < query.length; fi++) {
    if (file[fi] === query[qi]) qi++;
  }
  return qi === query.length;
}
```

Implementation reuses `resolveWorktreePath` from `plugins/code-explorer/server/internal/resolve-worktree-path.ts` and `GIT` from `@plugins/infra/plugins/paths/server`.

### Client: `useResolvedFile` hook

```ts
type ResolvedFileState =
  | { status: "loading" }
  | { status: "exact"; path: string }
  | { status: "resolved"; path: string }       // single match → auto-navigate
  | { status: "ambiguous"; matches: string[] }  // multiple → show picker
  | { status: "not-found" }
```

Follows the same `useEffect` + `useState` + cancellation pattern as `useFileContent` (`plugins/.../file-pane/web/use-file-content.ts`).

### Client: `FileDisambiguation` component

Full-pane-body replacement (not a popover) showing:
- Header text: "Multiple files match"
- Scrollable list of full paths as clickable buttons
- Filename in bold, directory prefix in muted — like VS Code quick-open

```ts
function FileDisambiguation({ query, matches, onSelect }: {
  query: string;
  matches: string[];
  onSelect: (path: string) => void;
})
```

### Integration into existing pane bodies

Both `TaskFilePeekBody` and `ConvFilePeekPaneBody` get the same pattern:

1. Call `useResolvedFile(worktree, filePath)` unconditionally
2. `useEffect`: when `status === "resolved"`, call `pane.open(...)` with the full path (auto-navigate)
3. When `status === "ambiguous"`, render `<FileDisambiguation>` instead of `<FileContent>`
4. When `status === "exact"` or `"not-found"`, render as before (FileContent handles 404 internally)

All existing hooks (`useFileRenderers`, `useEditedFiles`) remain called unconditionally to satisfy React's rules of hooks.

## Files

### New: `plugins/code-explorer/plugins/file-resolve/`

| File | Purpose |
|------|---------|
| `package.json` | `@singularity/plugin-code-explorer-file-resolve` |
| `CLAUDE.md` | Plugin docs |
| `server/index.ts` | `ServerPluginDefinition` with `GET /api/code/:worktree/resolve` |
| `server/internal/resolve-handler.ts` | Endpoint handler: exact check → git ls-files → subsequence match |
| `web/index.ts` | `PluginDefinition` (no contributions) + barrel exports |
| `web/internal/use-resolved-file.ts` | `useResolvedFile` hook |
| `web/internal/file-disambiguation.tsx` | `FileDisambiguation` component |

### Modified

| File | Change |
|------|--------|
| `plugins/tasks/plugins/task-file-peek/web/panes.tsx` | Add `useResolvedFile` + auto-navigate + ambiguous branch |
| `plugins/conversations/.../file-pane/web/file-peek-pane.tsx` | Same pattern, preserving existing line-number stripping |

### Dependency direction

```
task-file-peek  ───►  code-explorer/plugins/file-resolve/web
conv-file-pane  ───►  code-explorer/plugins/file-resolve/web
file-resolve/server ───►  code-explorer/server (resolveWorktreePath)
file-resolve/server ───►  infra/paths/server (GIT)
```

Clean DAG — the new plugin exports only, never imports from its consumers.

## Edge cases

- **Exact paths**: resolve returns `kind: "exact"` after a single `Bun.file().exists()` check — zero overhead for already-correct paths
- **Line numbers**: stripped by the pane body before calling `useResolvedFile`; re-appended when auto-navigating
- **Auto-navigate loop**: on redirect, the new `filePath` is exact → `kind: "exact"` → renders normally, no loop
- **Absolute paths**: if the path starts with `/`, the exact-check via `resolve(root, path)` + `isPathInside` rejects it; the git ls-files step only has relative paths, so no match → `not-found`
- **Many matches** (e.g. `index.ts`): the disambiguation list is scrollable; full paths let users distinguish

## Verification

1. `./equin build` — ensures new plugin is discovered and registered
2. Open a task with a description containing a partial path like `task-detail/panes.tsx`
3. Click the file link → should auto-resolve to the full path and show the file
4. Test with a path that has multiple matches (e.g. `index.ts`) → disambiguation picker should appear
5. Test with an exact path → should work as before with no extra latency
6. Test with a nonexistent path → "File not found." as before
