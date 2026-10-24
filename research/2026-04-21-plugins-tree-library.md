# Cleanup Phase 3b — `plugins/tree` library plugin

## Context

Three tree-hierarchy utilities — `buildTree`, `isDescendant`, `computeDrop` — are duplicated verbatim between `plugins/tasks/web/components/tasks-list.tsx` and `plugins/agents/web/components/agents-list.tsx`. The parent cleanup plan ([`2026-04-18-global-plugin-duplication-cleanup.md`](./2026-04-18-global-plugin-duplication-cleanup.md)) Phase 3b calls for extracting them into a new library plugin. This doc locks in the concrete shape and adapts to the v2 module-boundary convention ([`2026-04-20-global-plugin-module-boundaries-v2.md`](./2026-04-20-global-plugin-module-boundaries-v2.md)) which replaces the original `shared/api.ts` naming with `shared/index.ts` as the single barrel.

Goal: land a self-contained library plugin with empty contributions, a `shared/index.ts` surface of three generic functions + one type, and two migrated consumers — with no behavior change.

## Scaffold

```
plugins/tree/
├── package.json          # @singularity/plugin-tree (mirrors plugins/launch/package.json)
├── shared/
│   └── index.ts          # buildTree, isDescendant, computeDrop, TreeNode, DropZone
└── web/
    └── index.ts          # trivial PluginDefinition with contributions: []
```

No `server/` folder — both current consumers are web-only. Server-side tree helpers (tx-aware `isDescendantInDb`, generic `nextRankUnder`) are deferred per the parent plan's Phase 4.

## File details

### `plugins/tree/package.json`

Mirror `plugins/launch/package.json`:

```json
{
  "name": "@singularity/plugin-tree",
  "private": true,
  "version": "0.0.1"
}
```

### `plugins/tree/shared/index.ts`

Generic over `T` constrained to the shape both consumers already use. Depends only on `fractional-indexing` (already a workspace dep).

```typescript
import { generateKeyBetween } from "fractional-indexing";

export type DropZone = "before" | "after" | "child";

export type TreeNode<T> = T & { children: TreeNode<T>[] };

type Node = { id: string; parentId: string | null; rank: string };

export function buildTree<T extends Node>(rows: readonly T[]): TreeNode<T>[] {
  const byId = new Map<string, TreeNode<T>>();
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
  const roots: TreeNode<T>[] = [];
  byId.forEach((node) => {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

export function isDescendant<T extends { id: string; parentId: string | null }>(
  rows: readonly T[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const parents = new Map(rows.map((r) => [r.id, r.parentId] as const));
  let cur: string | null = candidateId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parents.get(cur) ?? null;
  }
  return false;
}

export function computeDrop<T extends Node>(
  rows: readonly T[],
  draggedId: string,
  zone: DropZone,
  targetId: string,
): { parentId: string | null; rank: string } | null {
  const target = rows.find((r) => r.id === targetId);
  if (!target) return null;

  if (zone === "child") {
    const children = rows
      .filter((r) => r.parentId === target.id && r.id !== draggedId)
      .sort((a, b) => a.rank.localeCompare(b.rank));
    const last = children[children.length - 1];
    try {
      return {
        parentId: target.id,
        rank: generateKeyBetween(last?.rank ?? null, null),
      };
    } catch {
      return null;
    }
  }

  const siblings = rows
    .filter((r) => r.parentId === target.parentId && r.id !== draggedId)
    .sort((a, b) => a.rank.localeCompare(b.rank));
  const idx = siblings.findIndex((s) => s.id === target.id);
  if (idx === -1) return null;

  try {
    if (zone === "before") {
      const prev = siblings[idx - 1];
      return {
        parentId: target.parentId,
        rank: generateKeyBetween(prev?.rank ?? null, target.rank),
      };
    }
    const next = siblings[idx + 1];
    return {
      parentId: target.parentId,
      rank: generateKeyBetween(target.rank, next?.rank ?? null),
    };
  } catch {
    return null;
  }
}
```

Notes:
- `TreeNode<T>` is the flat intersection `T & { children: TreeNode<T>[] }`, matching the current call-site pattern `node.title` / `node.name` / `node.status`. An `{ item, children }` wrapper would require invasive edits in two places for no gain.
- Tasks currently sorts with `(a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)`; agents uses `.localeCompare`. Both are equivalent for `fractional-indexing` output — standardizing on `.localeCompare`.
- `DropZone` is exported so consumers can reuse it (both files declare the same type locally).

### `plugins/tree/web/index.ts`

Mirrors `plugins/launch/web/index.ts`:

```typescript
import type { PluginDefinition } from "@core";

export default {
  id: "tree",
  name: "Tree",
  description: "Tree hierarchy utilities (buildTree, isDescendant, computeDrop) for list plugins.",
  contributions: [],
} satisfies PluginDefinition;
```

No re-exports from `web/` — the public surface lives in `shared/`, consumers import from `@plugins/primitives/plugins/tree/shared`.

## Consumer migration

### `plugins/tasks/web/components/tasks-list.tsx`

- Delete local `DropZone` type (line ~63), `TreeNode` type (line ~111), `buildTree` (113–125), `isDescendant` (142–157), `computeDrop` (159–205).
- Remove the direct `generateKeyBetween` import (line 37) **only if** no other uses remain in the file — `addBelow` at lines 256–260 still calls it, so **keep the import**.
- Add: `import { buildTree, computeDrop, isDescendant, type DropZone, type TreeNode } from "@plugins/primitives/plugins/tree/shared";`
- No call-site edits needed — generic inference picks up `Task`.

### `plugins/agents/web/components/agents-list.tsx`

- Delete local `DropZone` type (line 38), `TreeNode` type (line 36), `buildTree` (40–52), `isDescendant` (54–69), `computeDrop` (71–117).
- Keep `generateKeyBetween` import — not used locally after the deletion (verify: search shows only `computeDrop` uses it in this file, so the import **can be removed**). Confirm during execution with a grep.
- Add: `import { buildTree, computeDrop, isDescendant, type DropZone, type TreeNode } from "@plugins/primitives/plugins/tree/shared";`

### `web/src/plugins.ts`

Append one import and one array entry. Library plugins have no UI so ordering is cosmetic; place next to `launchPlugin` to group pure-utility plugins:

```typescript
import treePlugin from "@plugins/primitives/plugins/tree/web";
// ...
export const plugins: PluginDefinition[] = [
  shellPlugin,
  welcomePlugin,
  launchPlugin,
  treePlugin,
  // ...
];
```

No server-side registration (`server/src/plugins.ts` is untouched — plugin has no `server/` folder).

## Critical files

- New: `plugins/tree/package.json`, `plugins/tree/shared/index.ts`, `plugins/tree/web/index.ts`
- Modified: `plugins/tasks/web/components/tasks-list.tsx`, `plugins/agents/web/components/agents-list.tsx`, `web/src/plugins.ts`
- Reference: `plugins/launch/` (template shape), `plugins/tasks-core/shared/index.ts` (barrel style)

## Verification

1. Run `./equin build` — must compile cleanly (TypeScript, Vite, server).
2. Open `http://<worktree>.localhost:9000`:
   - Navigate to Tasks sidebar → list renders; click the expand chevron on a parent; add a task; drag a task before/after/onto another task — verify parent/rank updates persist.
   - Navigate to Agents sidebar → same checks (build, reorder, nest).
3. Grep verification that the duplicates are gone:
   - `grep -rn "function buildTree" plugins/tasks plugins/agents` → zero matches.
   - `grep -rn "function isDescendant" plugins/tasks/web plugins/agents/web` → zero matches.
   - `grep -rn "function computeDrop" plugins/tasks plugins/agents` → zero matches.
   - `grep -rn "@plugins/primitives/plugins/tree/shared" plugins/tasks plugins/agents` → one match in each consumer.
4. Confirm `docs/plugins.md` regeneration (happens during build) includes a `tree` entry with empty Contributes block.
