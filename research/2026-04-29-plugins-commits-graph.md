---
title: Commits-graph plugin (toolbar chip + side pane)
date: 2026-04-29
category: plugins
---

# Commits graph plugin

## Context

The conversation toolbar already shows a push counter chip, but there is no visibility into how the worktree branch has diverged from `main` between pushes — agents commonly accumulate several commits before pushing, and reviewers want a quick way to spot drift (commits ahead) and rebase pressure (commits behind). VSCode's Git Graph extension solves this with a colored chain of commits; we want the same affordance inline in the conversation pane.

The change adds a single new sub-plugin under `conversation-view` that:

1. Renders a `↑N ↓M` chip in the conversation toolbar, computed against `main`.
2. Opens a child pane on click that draws the chain of commits between the merge-base and HEAD as a single colored rail.

Both numbers and the commit list update live via the existing push-trigger plumbing.

## Plugin layout

New plugin: `plugins/conversations/plugins/conversation-view/plugins/commits-graph/`

```
commits-graph/
  package.json                   # @singularity/plugin-conversations-conversation-view-commits-graph
  CLAUDE.md                      # one-paragraph plugin doc
  web/
    index.ts                     # barrel: definePlugin + Pane.Register + conversationPane.Actions
    panes.tsx                    # convCommitsGraphPane = Pane.define({ parent: conversationPane, path: "commits" })
    components/
      commits-chip.tsx           # toolbar chip — uses useResource(commitDeltaResource)
      commits-graph-body.tsx     # side-pane body — useResource(commitsGraphResource)
      commit-rail.tsx            # SVG rail + dot per commit row (presentation)
  server/
    index.ts                     # ServerPluginDefinition: resources + httpRoutes if any
    internal/
      git.ts                     # local runGit() helper (Bun.spawn /usr/bin/git)
      compute-delta.ts           # ahead/behind via `git rev-list --left-right --count main...HEAD`
      compute-graph.ts           # commits via `git log --format=... merge-base..HEAD`
      resources.ts               # commitDeltaResource + commitsGraphResource (with pushLanded trigger)
  shared/
    index.ts                     # barrel: types + resource descriptors
    types.ts                     # CommitDelta, CommitGraph, CommitRow Zod schemas
```

> The plugin sits inside the `conversation-view` umbrella (rule from CLAUDE.md: 2+ related plugins go under an umbrella; this one fits the existing umbrella naturally — same depth as `push-counter`, `terminal-pane`, `tasks-panel`).

## Data model

```ts
// shared/types.ts
export const CommitDeltaSchema = z.object({
  attemptId: z.string(),
  ahead: z.number().int().nonnegative(),   // commits in HEAD not in main
  behind: z.number().int().nonnegative(),  // commits in main not in HEAD
  mergeBase: z.string().nullable(),        // sha of merge-base or null if no common ancestor
});

export const CommitRowSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),                  // ISO
  parents: z.array(z.string()),
});

export const CommitGraphSchema = z.object({
  attemptId: z.string(),
  mergeBase: z.string().nullable(),
  commits: z.array(CommitRowSchema),       // newest-first, merge-base..HEAD (inclusive HEAD, exclusive merge-base)
});
```

Both shapes are surfaced as live-state resources keyed by `attemptId`:

```ts
// server/internal/resources.ts
export const commitDeltaResource = resourceDescriptor({
  name: "commits-graph.delta",
  paramsSchema: z.object({ attemptId: z.string() }),
  valueSchema: CommitDeltaSchema,
  load: ({ attemptId }) => computeDelta(attemptId),
  triggers: [pushLanded.on({ attemptId: filter.equals })], // pattern from pushesResource
});

export const commitsGraphResource = resourceDescriptor({
  name: "commits-graph.graph",
  paramsSchema: z.object({ attemptId: z.string() }),
  valueSchema: CommitGraphSchema,
  load: ({ attemptId }) => computeGraph(attemptId),
  triggers: [pushLanded.on({ attemptId: filter.equals })],
});
```

> Verify the exact `resourceDescriptor` / trigger signature against `pushesResource` in `plugins/tasks-core/server/internal/` before writing — copy that file's pattern verbatim.

## Git plumbing

`server/internal/git.ts` — copy the `runGit` shape from `plugins/code-explorer/server/internal/get-file-diff.ts:16-31`:

```ts
const GIT = "/usr/bin/git";
async function runGit(args: string[], cwd: string): Promise<string | null> {
  const proc = Bun.spawn([GIT, "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out : null;
}
```

`compute-delta.ts`:

```ts
// One git call returns both numbers in "<behind>\t<ahead>" form:
const out = await runGit(["rev-list", "--left-right", "--count", "main...HEAD"], wtPath);
// fall back to ahead=0, behind=0 with mergeBase=null if main is unreachable from this worktree
const mergeBase = (await runGit(["merge-base", "main", "HEAD"], wtPath))?.trim() ?? null;
```

`compute-graph.ts`:

```ts
const range = mergeBase ? `${mergeBase}..HEAD` : "HEAD";
const out = await runGit([
  "log",
  range,
  "--format=%H%x09%h%x09%P%x09%an%x09%ae%x09%aI%x09%s",
], wtPath);
// Split by lines, parse \t-separated fields. Cap at e.g. 200 commits to bound payload.
```

The worktree path comes from `getAttempt(attemptId).worktreePath` (already used by `code-explorer/server/internal/resolve-worktree-path.ts`).

## Toolbar chip

`web/components/commits-chip.tsx` — mirror `push-counter-button.tsx`:

```tsx
const { conversation } = conversationPane.useData();
const { data } = useResource(commitDeltaResource, { attemptId: conversation.attemptId });
const ahead = data?.ahead ?? 0;
const behind = data?.behind ?? 0;
const match = usePaneMatch();
const isOpen = match?.chain.some(e => e.pane === convCommitsGraphPane._internal) ?? false;

return (
  <button
    type="button"
    onClick={() => isOpen
      ? convCommitsGraphPane.close()
      : convCommitsGraphPane.open({ convId: conversation.id })}
    aria-pressed={isOpen}
    title={`${ahead} ahead, ${behind} behind main`}
    className="inline-flex items-center gap-1 px-1 text-xs tabular-nums text-muted-foreground hover:text-foreground"
  >
    <MdAltRoute className="size-4" />
    <span>↑{ahead}</span>
    {behind > 0 && <span className="text-amber-500">↓{behind}</span>}
  </button>
);
```

When `ahead === 0 && behind === 0` the chip still renders (for affordance) — consider hiding only when `data === null` (worktree has no main yet, e.g. detached state).

## Side pane

`web/panes.tsx`:

```ts
export const convCommitsGraphPane = Pane.define({
  id: "conv-commits-graph",
  parent: conversationPane,
  path: "commits",
  component: ConvCommitsGraphBody,
});

function ConvCommitsGraphBody() {
  return (
    <PaneChrome pane={convCommitsGraphPane} title="Commits">
      <CommitsGraphBody />
    </PaneChrome>
  );
}
```

`web/components/commits-graph-body.tsx`:

- `useResource(commitsGraphResource, { attemptId })` for the full list.
- Render a vertical list, newest-first. Each row is a fixed-height (~32px) flex line with three regions:
  1. **Rail** (28px wide) — SVG with a single colored rail (`stroke="var(--primary)"`) and a filled circle for the commit dot. Top of rail extends above the first row, bottom extends below the last row to indicate continuation. Below the merge-base commit, switch the rail color to `var(--muted-foreground)` to indicate "main".
  2. **Sha + subject** — short sha (monospace, muted), then subject (truncate w/ ellipsis).
  3. **Author + relative time** — right-aligned, muted.
- Empty state (no commits ahead): "Up to date with main".
- Error state: surface `runGit` failure message.

`commit-rail.tsx` — the SVG primitive. Single rail per commit row; we own a single branch so a single x-coordinate is enough. Reserved as a separate component so a future "current + main" or "all worktrees" mode can grow into multi-rail without restructuring `commits-graph-body.tsx`.

> Note: scope is **single rail** per the design decision — no multi-branch DAG layout. Keep `commit-rail.tsx` purely about drawing one column; we are deliberately not building VSCode's full multi-branch crossing logic in v1.

## Barrel + registration

`web/index.ts`:

```ts
import { CommitsChip } from "./components/commits-chip";
import { conversationPane } from "@plugins/conversations/web";
import { Pane } from "@plugins/primitives/web";
import { convCommitsGraphPane } from "./panes";

export default definePlugin({
  id: "conversation-commits-graph",
  contributions: [
    Pane.Register({ pane: convCommitsGraphPane }),
    conversationPane.Actions({ component: CommitsChip }),
  ],
});
```

`server/index.ts`:

```ts
export default {
  id: "conversation-commits-graph",
  resources: [commitDeltaResource, commitsGraphResource],
} satisfies ServerPluginDefinition;
```

Then register both barrels in `web/src/plugins.ts` and `server/src/plugins.ts`.

## Critical files (touched)

- **New**: everything under `plugins/conversations/plugins/conversation-view/plugins/commits-graph/`
- **Modified**: `web/src/plugins.ts` and `server/src/plugins.ts` — register the new plugin barrels
- **Modified**: `docs/plugins-compact.md` and `docs/plugins-details.md` — autogenerated by the doc check; will regenerate on `./equin check`

## Existing helpers reused

- `plugins/code-explorer/server/internal/get-file-diff.ts:16-31` — `runGit` shape (copy locally; not exported)
- `plugins/code-explorer/server/internal/resolve-worktree-path.ts` — `resolveWorktreePath` pattern (we resolve via `getAttempt` directly since we always have an `attemptId`, but the conventions match)
- `plugins/tasks-core/server/internal/.../resources.ts` — `pushesResource` is the closest live-state resource template; copy its trigger wiring for `pushLanded`
- `plugin-core` `Pane.define`, `Pane.Register`, `PaneChrome`, `usePaneMatch` — pane primitive
- `plugins/conversations/plugins/conversation-view/plugins/push-counter/web/components/push-counter-button.tsx` — chip styling/structure template
- `plugins/conversations/plugins/conversation-view/plugins/terminal-pane/web/panes.tsx` — toggle-pane template
- `MdAltRoute` from `react-icons/md` for the chip icon (or `MdAccountTree` — pick one that reads as "branch divergence")

## Verification

1. `./equin build` from the worktree root — confirms the plugin builds, schema is unchanged, gateway is updated.
2. Open `http://att-1777478429-tb8d.localhost:9000/c/<conv-id>` and look for the new chip in the conversation toolbar.
3. Make a commit in the worktree (`./equin push -m "test"`) — the chip's `↑N` should bump live without reload (resource invalidates on `pushLanded`).
4. Click the chip — side pane opens at `/c/<id>/commits` showing the new commit at the top of the rail.
5. Click the chip again to close.
6. Edge cases:
   - Worktree with zero commits ahead — chip shows `↑0`, pane shows empty-state copy.
   - Worktree where `main` was force-pushed (behind > 0) — `↓N` appears in amber.
   - Detached worktree / no merge base — `mergeBase: null` from the resource; chip hides; pane shows "no shared history with main".
7. Use `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/c/<id> --click "Commits" --out /tmp/commits` to capture before/after of the toggle.
8. `./equin check` — confirms plugin-boundary rules + autogen docs are in sync.

## Out of scope (v1)

- Multi-rail / multi-branch layout (other worktrees' tips). Plugin shape is ready for it; not implemented.
- Click-through on a commit row to see the diff (will route through `code-explorer`'s diff pane in a follow-up).
- Inline rebase / push actions from the side pane.
- Caching / memoising commit lookups across conversations sharing the same attempt — the resource layer's per-key memoisation is sufficient.
