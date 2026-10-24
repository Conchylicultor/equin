# Placeholder Primitive

## Context

4 plugins under `conversation-view/plugins/code/plugins/file-pane/` each define an identical local `Placeholder` component — same props, same JSX, copy-pasted. 8+ other sites spread `<div className="p-X text-sm text-muted-foreground">` inline. The API has already converged in the wild: `{children, tone?: "muted" | "error"}`. A shared primitive eliminates the duplication and gives future panes a semantic component to reach for.

## Implementation

### New files

**`plugins/primitives/plugins/placeholder/package.json`**
```json
{
  "name": "@singularity/plugin-primitives-placeholder",
  "private": true,
  "version": "0.0.1"
}
```

**`plugins/primitives/plugins/placeholder/web/internal/placeholder.tsx`**
```tsx
import { cn } from "@/lib/utils";

export interface PlaceholderProps {
  children: React.ReactNode;
  tone?: "muted" | "error";
}

export function Placeholder({ children, tone = "muted" }: PlaceholderProps) {
  return (
    <div
      className={cn(
        "px-3 py-2 text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
```

**`plugins/primitives/plugins/placeholder/web/index.ts`**
```ts
import type { PluginDefinition } from "@core";

export { Placeholder } from "./internal/placeholder";
export type { PlaceholderProps } from "./internal/placeholder";

export default {
  id: "placeholder",
  name: "Placeholder",
  description:
    "Muted text placeholder for loading, empty, and error states. Props: children, tone (muted | error).",
  contributions: [],
} satisfies PluginDefinition;
```

**`plugins/primitives/plugins/placeholder/CLAUDE.md`** — minimal seed with `# placeholder` heading; `./equin build` auto-fills the reference block.

### Files to modify (4 identical local Placeholder replacements)

All four follow the same pattern:
1. Add import: `import { Placeholder } from "@plugins/primitives/plugins/placeholder/web";`
2. Delete the local `function Placeholder(…) { … }` definition at the bottom of the file.

| File | Local definition line |
|---|---|
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/markdown/web/components/markdown-view.tsx` | 36 |
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/raw/web/components/raw-view.tsx` | 122 |
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web/components/diff-view.tsx` | 407 |
| `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/components/review-view.tsx` | 319 |

> `review-view.tsx` used `px-4 py-3` (vs `px-3 py-2` in the other three). The difference is cosmetic; use the canonical shared padding.

### Optional follow-up: inline div migrations

These sites use the same semantic pattern but as raw `<div>`:

| File | Current class | Text |
|---|---|---|
| `plugins/conversations/plugins/conversation-view/web/panes.tsx:39` | `flex h-full items-center justify-center p-6 text-sm text-muted-foreground` | "Loading conversation…" |
| `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commit-diff-view.tsx:18,62` | `p-4 text-sm text-muted-foreground` | "Loading…" / "No changes in this commit." |
| `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-graph-body.tsx:45` | `p-4 text-sm text-muted-foreground` | "No shared history with main." |
| `plugins/conversations-recover/web/components/recovery-view.tsx:147,149` | `p-6 text-sm text-muted-foreground` | "Loading…" / "No recently closed conversations." |
| `plugins/agents/web/components/agent-detail.tsx:97` | `text-muted-foreground p-6 text-sm` | "Loading…" |
| `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx:229,231` | `p-6 text-sm text-muted-foreground` | "Loading…" / "No worktrees found." |

These have larger padding (`p-4`/`p-6`) than the canonical `px-3 py-2`. Migrating them to `<Placeholder>` is a minor visual change (less padding). Treat as best-effort: migrate if the visual delta is acceptable, leave otherwise.

**Out of scope:** the centered `EmptyState` (catalog tables, `h-32 flex items-center justify-center`) and the dashed-border `Empty` (events-test) are different visual treatments; they do not fit the same API and should stay local or become their own variant later.

## Verification

```bash
# Build to confirm auto-registration and no import errors
./equin build

# Spot-check: open a file in the diff/raw/markdown/review panes
# Confirm loading and error states still render correctly
bunx playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" \
  http://att-1778658801-ixn6.localhost:9000 /tmp/placeholder-check.png

# Lint — plugin-boundary check should pass
./equin check
```
