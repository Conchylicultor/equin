# Unify Expand-All / Collapse-All Buttons

## Context

There are 5 expand-all implementations (excluding diff-view hunk expansion, which is unrelated) across 3 patterns, with inconsistent styling and duplicated logic:

1. **TreeList toolbar** (`plugins/primitives/plugins/tree/web/internal/tree-list.tsx:305-318`) — icon-only, `size-7`, `hover:bg-accent`. Internal inline `<button>`.

2. **Per-row subtree actions** — near-identical copies:
   - `plugins/tasks/plugins/task-list/web/components/expand-collapse-all-action.tsx`
   - `plugins/agents/web/components/expand-collapse-all-action.tsx`
   
   Both duplicate a 33-line `subtreeWithChildren()` DFS and identical button markup (`size-6`, `hover:bg-background/60`). Only difference: resource + patch function + prop name.

3. **Ad-hoc flat-list expand-all** — inconsistent styling:
   - `plugins/review/plugins/code-review/web/components/code-review-section.tsx` — `<Button variant="ghost" size="sm">` with **text only, no icon**
   - `plugins/review/plugins/plugin-changes/web/components/plugin-changes-section.tsx` — raw `<button>` with icon `size-3.5` + text, different hover style

## Plan

### Part 1: `ExpandAllButton` in the collapsible primitive

A single button component used by all 5 call sites, with two variants for context-appropriate styling.

**New file:** `plugins/primitives/plugins/collapsible/web/internal/expand-all-button.tsx`

```tsx
type ExpandAllButtonProps = {
  allExpanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  variant?: "compact" | "full";
};

function ExpandAllButton({ allExpanded, onToggle, disabled, variant = "compact" }: ExpandAllButtonProps)
```

Both variants use `MdUnfoldMore`/`MdUnfoldLess` at `size-4`, proper `aria-label` and `title`.

- **`compact`** — icon-only square button. `size-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground`. Used in TreeList toolbar and per-row subtree actions.
- **`full`** — icon + "Expand all"/"Collapse all" text. `text-xs text-muted-foreground hover:text-foreground transition-colors`. Used in review section toolbars.

### Part 2: `useExpandAll` hook in the collapsible primitive

Eliminates duplicated `Set<string>` state management between the two review sections.

**New file:** `plugins/primitives/plugins/collapsible/web/internal/use-expand-all.ts`

```ts
function useExpandAll(ids: readonly string[]): {
  expanded: ReadonlySet<string>;
  allExpanded: boolean;
  toggleAll: () => void;
  toggle: (id: string) => void;
}
```

Manages `useState<ReadonlySet<string>>`, derives `allExpanded` via `ids.every()`. `toggleAll` clears or fills. `toggle` does immutable single-id flip.

**Update barrel:** `plugins/primitives/plugins/collapsible/web/index.ts` — add `useExpandAll`, `ExpandAllButton` exports.

### Part 3: `useSubtreeExpandAll` hook in the tree primitive

Eliminates the duplicated `subtreeWithChildren()` DFS walk between tasks and agents.

**New file:** `plugins/primitives/plugins/tree/web/internal/use-subtree-expand-all.ts`

```ts
type ExpandableRow = { id: string; parentId: string | null; expanded: boolean };

function subtreeWithChildren(rows: readonly ExpandableRow[], rootId: string): ExpandableRow[]

function useSubtreeExpandAll(
  rows: readonly ExpandableRow[],
  rootId: string,
  patch: (id: string, expanded: boolean) => Promise<void>,
): { willCollapse: boolean; toggle: () => void }
```

Iterative DFS moved verbatim from the duplicated implementations. Hook computes `willCollapse`, returns `toggle` that fires parallel patches with `e.stopPropagation()` handled internally.

**Update barrel:** `plugins/primitives/plugins/tree/web/index.ts` — add `useSubtreeExpandAll` export.

### Part 4: Migrate all 5 consumers

**`plugins/primitives/plugins/tree/web/internal/tree-list.tsx` (TreeList toolbar):**
- Replace the inline `<button>` (lines 305-318) with `<ExpandAllButton variant="compact" allExpanded={allExpanded} onToggle={expandAll} />`.
- Import `ExpandAllButton` from `@plugins/primitives/plugins/collapsible/web`.
- Remove `MdUnfoldMore`, `MdUnfoldLess` imports (if no longer used elsewhere in the file — check the hideTerminal button first).

**`plugins/tasks/plugins/task-list/web/components/expand-collapse-all-action.tsx`:**
- Delete local `subtreeWithChildren()` and `TaskRow` type.
- Import `useSubtreeExpandAll` from `@plugins/primitives/plugins/tree/web`.
- Import `ExpandAllButton` from `@plugins/primitives/plugins/collapsible/web`.
- Wire: `const { willCollapse, toggle } = useSubtreeExpandAll(rows, taskId, patch)`.
- Render: `<ExpandAllButton variant="compact" allExpanded={!willCollapse} onToggle={toggle} />`.
- File shrinks from ~77 to ~20 lines.

**`plugins/agents/web/components/expand-collapse-all-action.tsx`:**
- Same transformation as tasks, with `agentsResource` + `patchAgent`.

**`plugins/review/plugins/code-review/web/components/code-review-section.tsx`:**
- Replace manual `useState<Set<string>>` + `toggleAll` + `toggleOne` with `useExpandAll(sortedPaths)`.
- Replace `<Button variant="ghost" size="sm">{text}</Button>` with `<ExpandAllButton variant="full" allExpanded={allExpanded} onToggle={toggleAll} disabled={!canToggle} />`.
- Gains an icon it currently lacks.

**`plugins/review/plugins/plugin-changes/web/components/plugin-changes-section.tsx`:**
- Replace manual `useState<ReadonlySet<string>>` + `useCallback` wrappers with `useExpandAll(allPaths)`.
- Replace raw `<button>` + inline icons with `<ExpandAllButton variant="full" allExpanded={allExpanded} onToggle={toggleAll} />`.
- Icon normalizes from `size-3.5` to `size-4`. Remove `MdUnfoldMore`, `MdUnfoldLess`, `useCallback` imports.

### Result

| Surface | Before | After |
|---|---|---|
| TreeList toolbar | inline `<button>`, `size-7`, `hover:bg-accent` | `ExpandAllButton variant="compact"` |
| Task/Agent per-row | duplicated DFS, inline `<button>`, `size-6`, `hover:bg-background/60` | `useSubtreeExpandAll` + `ExpandAllButton variant="compact"` |
| Code review toolbar | `<Button>`, text-only, no icon | `useExpandAll` + `ExpandAllButton variant="full"` |
| Plugin changes | raw `<button>`, icon `size-3.5` + text | `useExpandAll` + `ExpandAllButton variant="full"` |

All expand-all buttons now come from `ExpandAllButton`. Compact surfaces get icon-only; spacious surfaces get icon + text. Consistent hover, icon size, accessibility attributes everywhere.

## Files to create

- `plugins/primitives/plugins/collapsible/web/internal/expand-all-button.tsx`
- `plugins/primitives/plugins/collapsible/web/internal/use-expand-all.ts`
- `plugins/primitives/plugins/tree/web/internal/use-subtree-expand-all.ts`

## Files to modify

- `plugins/primitives/plugins/collapsible/web/index.ts` — add barrel exports
- `plugins/primitives/plugins/tree/web/index.ts` — add barrel export
- `plugins/primitives/plugins/tree/web/internal/tree-list.tsx` — use `ExpandAllButton`
- `plugins/tasks/plugins/task-list/web/components/expand-collapse-all-action.tsx` — use hooks + button
- `plugins/agents/web/components/expand-collapse-all-action.tsx` — use hooks + button
- `plugins/review/plugins/code-review/web/components/code-review-section.tsx` — use hooks + button
- `plugins/review/plugins/plugin-changes/web/components/plugin-changes-section.tsx` — use hooks + button

## Verification

1. `./equin build` — compiles and deploys
2. Visual check at `http://<worktree>.localhost:9000`:
   - Tasks sidebar: expand-all per-row buttons still work on parent tasks
   - Agents sidebar: same
   - TreeList toolbar expand-all still toggles all tree nodes
   - Review pane > Code Review: expand/collapse all now shows icon + text, disabled when empty
   - Review pane > Plugin Changes: same styling as code review
3. `./equin check` — plugin boundaries, lint
