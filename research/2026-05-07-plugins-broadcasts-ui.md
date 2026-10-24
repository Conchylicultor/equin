# Broadcast Notification Control UI

## Context

`cli/broadcasts.json` is a file committed to `main` that lets a maintainer inject messages into stale agent worktrees. When an agent runs `build`, `push`, or `check`, the CLI reads this file from `origin/main` and prints matching entries — `error`-severity ones halt the command entirely, forcing a rebase. There is currently no UI for editing these entries; it must be done by hand with a text editor.

This plan adds a `broadcasts` debug sub-plugin that renders the current list of broadcast entries and lets the user add or delete entries, writing changes directly to `cli/broadcasts.json` in the main worktree. The user then commits and pushes via `./equin push` as usual.

---

## Implementation Plan

### 1. File Structure

```
plugins/debug/plugins/broadcasts/
  package.json
  CLAUDE.md
  server/
    index.ts
    internal/
      handle-read.ts    # GET /api/debug/broadcasts
      handle-write.ts   # PUT /api/debug/broadcasts
  web/
    index.ts
    panes.tsx
    components/
      broadcasts-panel.tsx
```

### 2. Shared Types

The `Broadcast` type from `cli/src/broadcasts.ts` is duplicated locally in the plugin (it lives in the CLI, not a shared package — no import path exists):

```typescript
type BroadcastSeverity = "error" | "warning" | "info";
type BroadcastCommand = "build" | "push" | "check";

interface BroadcastEntry {
  severity: BroadcastSeverity;
  message: string;
  since?: string;   // commit hash — show if worktree merge-base is BEFORE this commit
  until?: string;   // commit hash — stop showing once merge-base reaches this commit
  commands?: BroadcastCommand[];  // if absent, applies to all commands
}
```

### 3. Server Side

**`server/index.ts`** — two routes, no DB dependencies:

```typescript
export default {
  id: "debug-broadcasts",
  httpRoutes: {
    "GET /api/debug/broadcasts": handleRead,
    "PUT /api/debug/broadcasts": handleWrite,
  },
} satisfies ServerPluginDefinition;
```

**`server/internal/handle-read.ts`** — reads the file from the main worktree:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";

export async function handleRead(): Promise<Response> {
  const root = await ensureMainWorktreeRoot();
  const path = join(root, "cli/broadcasts.json");
  try {
    const raw = await readFile(path, "utf-8");
    const entries = JSON.parse(raw) as BroadcastEntry[];
    return Response.json({ ok: true, entries, path });
  } catch {
    return Response.json({ ok: true, entries: [], path });
  }
}
```

**`server/internal/handle-write.ts`** — full-replace write:

```typescript
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";

export async function handleWrite(req: Request): Promise<Response> {
  const root = await ensureMainWorktreeRoot();
  const path = join(root, "cli/broadcasts.json");
  const body = (await req.json()) as { entries: BroadcastEntry[] };
  await writeFile(path, JSON.stringify(body.entries, null, 2) + "\n", "utf-8");
  return Response.json({ ok: true });
}
```

### 4. Web Side

**`web/index.ts`** — same pattern as `memory`:

```typescript
export default {
  id: "debug-broadcasts",
  contributions: [
    Pane.Register({ pane: broadcastsPane }),
    Debug.Item({
      id: "broadcasts",
      title: "Broadcasts",
      icon: MdAnnouncement,
      onClick: () => broadcastsPane.open({}),
    }),
  ],
} satisfies PluginDefinition;
```

**`web/panes.tsx`** — standard pane wrapper with `PaneChrome`:

```typescript
export const broadcastsPane = Pane.define({
  id: "debug-broadcasts",
  after: [null],
  segment: "debug/broadcasts",
  component: BroadcastsBody,
});

function BroadcastsBody() {
  return (
    <PaneChrome pane={broadcastsPane} title="Broadcasts">
      <BroadcastsPanel />
    </PaneChrome>
  );
}
```

**`web/components/broadcasts-panel.tsx`** — full CRUD panel. Key sections:

1. **Header bar:** "Broadcast Messages" label + file path (small monospace) + "+ Add" button.

2. **Entry list:** Each row shows:
   - Severity badge (colored pill: `error`=red, `warning`=amber, `info`=blue)
   - Message text (main content)
   - Optional metadata row: `since`/`until` truncated commit hashes + commands filter chips (`build`, `push`, `check`)
   - Delete button (trash icon, triggers immediate save)

3. **Add form** (shown when "+ Add" is clicked, inline above the list):
   - Severity select (error / warning / info)
   - Message textarea
   - Since commit input (optional, placeholder: `abc1234`)
   - Until commit input (optional, placeholder: `def5678`)
   - Commands checkboxes: `build`, `push`, `check` (all = no filter)
   - "Add" and "Cancel" buttons

4. **Empty state:** "No active broadcasts" centered message when list is empty.

5. **Save behavior:** Saves on delete (optimistic update) and on "Add" (appends + closes form). Uses plain `fetch()` calls, no live-state (debug panel).

6. **Error handling:** Inline error banner if GET or PUT fails.

### 5. Package.json

```json
{
  "name": "@singularity/plugin-debug-broadcasts",
  "private": true,
  "version": "0.0.1"
}
```

### 6. Registration

Both `server/src/plugins.generated.ts` and `web/src/plugins.generated.ts` are auto-regenerated by `./equin build` — no manual edits needed.

---

## Verification

1. `./equin build` — confirms the new plugin is discovered and the generated files update correctly.
2. Open `http://<worktree>.localhost:9000` → Debug sidebar → "Broadcasts".
3. Panel loads with empty list (since `broadcasts.json` is currently `[]`).
4. Add an `info` broadcast with a test message → entry appears in the list → `cli/broadcasts.json` on disk is updated.
5. Delete the entry → list returns to empty → file is restored to `[]`.
6. Add an `error` broadcast → from a terminal, `cd` into the worktree and run `./equin build` → confirms the broadcast is printed and the command exits 1 (once the file is committed to `origin/main`; or test by temporarily hard-coding the path in `broadcasts.ts` to point at the local file).
