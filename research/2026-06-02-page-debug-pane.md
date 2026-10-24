# Page Plugin — Debug Pane (Task 4)

## Context

Task 4 of the page-editor vision ([`research/2026-05-25-plugins-page-vision.md`](2026-05-25-plugins-page-vision.md)).
Tasks 1–3 are done: the `editor` plugin (server tables/routes, core types/endpoints/resources,
`<BlockEditor documentId>`) and the `text` block plugin are fully implemented and registered.

There is currently **no surface to exercise them** — no app embeds `<BlockEditor>`. This task adds
a minimal debug harness: a sidebar entry in the Debug app that opens a pane rendering the block
editor against a test document, auto-creating that document (and a first block) when none exists.
The goal is to validate the full stack end-to-end (create → render → type → split → merge → indent → persist).

### Key finding driving the design

`POST /api/documents` ([`handle-create-document.ts`](../plugins/page/plugins/editor/server/internal/handle-create-document.ts))
creates a document with **zero blocks**. `<BlockEditor>` renders nothing when a document has no
blocks ([`block-editor.tsx`](../plugins/page/plugins/editor/web/components/block-editor.tsx)) and
there is no UI affordance to add the first block (new blocks only come from splitting an existing
one via Enter). **So the debug pane must seed one empty `text` block after creating the document**,
otherwise the editor is a dead, un-typeable surface.

## Approach

New **web-only** plugin at `plugins/page/plugins/debug/` (under the `page` umbrella, per the vision
doc — co-located with the editor it tests, keeping the page feature self-contained). It contributes
a `DebugApp.Sidebar` entry that opens a pane embedding `<BlockEditor>`.

Plugin registration is **automatic** — `./equin build` discovers `web/index.ts` from the
filesystem and regenerates `web.generated.ts` (with `dependsOn` derived from imports). No manual
registry edit.

### Files to create

```
plugins/page/plugins/debug/
  package.json                 # { name: "@singularity/plugin-page-debug", description, private, version }
  web/
    index.ts                   # definePlugin: Pane.Register + DebugApp.Sidebar
    panes.tsx                  # Pane.define + PaneChrome shell
    components/
      page-debug-panel.tsx     # ensure-document logic + <BlockEditor>
```

(No `CLAUDE.md` needed initially; the codegen reference block is added by the doc check on build.)

### `web/index.ts` — mirrors [`plugins/debug/plugins/memory/web/index.ts`](../plugins/debug/plugins/memory/web/index.ts)

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane, openPane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { sidebarNavItem } from "@plugins/primitives/plugins/app-shell/web";
import { MdEditNote } from "react-icons/md";
import { pageDebugPane } from "./panes";

export { pageDebugPane } from "./panes";

export default {
  id: "page-debug",
  name: "Page Editor",
  description: "Debug harness for the block-based page editor.",
  contributions: [
    Pane.Register({ pane: pageDebugPane }),
    DebugApp.Sidebar({
      id: "page-editor",
      ...sidebarNavItem({
        title: "Page Editor",
        icon: MdEditNote,
        onClick: () => openPane(pageDebugPane, {}, { mode: "root" }),
      }),
    }),
  ],
} satisfies PluginDefinition;
```

### `web/panes.tsx`

```tsx
import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { PageDebugPanel } from "./components/page-debug-panel";

export const pageDebugPane = Pane.define({
  id: "page-debug",
  segment: "page-editor",        // → /debug/page-editor
  component: PageDebugBody,
});

function PageDebugBody() {
  return (
    <PaneChrome pane={pageDebugPane} title="Page Editor">
      <PageDebugPanel />
    </PaneChrome>
  );
}
```

### `web/components/page-debug-panel.tsx` — the only real logic

Reads the live `documentsResource`; if empty, creates a document + one empty `text` block exactly
once (guarded by a ref to avoid duplicate fires across the re-renders that live-state notifications
trigger); then renders `<BlockEditor documentId={firstDoc.id} />`.

```tsx
import { useEffect, useRef } from "react";
import { useResource } from "@plugins/primitives/plugins/live-state/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { documentsResource, createDocument, createBlock } from "@plugins/page/plugins/editor/core";
import { BlockEditor } from "@plugins/page/plugins/editor/web";
import { textBlock } from "@plugins/page/plugins/text/core";

export function PageDebugPanel() {
  const docs = useResource(documentsResource);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (docs.pending || docs.data.length > 0 || creatingRef.current) return;
    creatingRef.current = true;
    void (async () => {
      const doc = await fetchEndpoint(createDocument, {}, { body: { title: "Debug Document" } });
      await fetchEndpoint(
        createBlock,
        { documentId: doc.id },
        { body: { type: textBlock.type, data: textBlock.schema.parse({ text: "" }) } },
      );
      // documentsLiveResource.notify() (server-side) refreshes useResource → re-render → editor mounts.
    })();
  }, [docs]);

  if (docs.pending) {
    return <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>;
  }
  const doc = docs.data[0];
  if (!doc) {
    return <div className="px-3 py-2 text-sm text-muted-foreground">Creating test document…</div>;
  }
  return <BlockEditor documentId={doc.id} />;
}
```

Notes:
- `creatingRef` (not state) guards against the create firing twice — the `createDocument` call
  triggers `documentsLiveResource.notify()`, which re-runs the effect before React state would catch up.
- Reuses `textBlock` from [`@plugins/page/plugins/text/core`](../plugins/page/plugins/text/core)
  for typed block creation (`textBlock.type` / `textBlock.schema`), matching the vision doc's
  "create blocks programmatically" pattern — no raw `"text"` string at the call site.
- Picks `docs.data[0]` (the existing/oldest document) so the harness is stable across reloads
  rather than spawning a new doc each visit.

### `package.json`

```json
{
  "name": "@singularity/plugin-page-debug",
  "description": "Debug harness for the block-based page editor.",
  "private": true,
  "version": "0.0.1"
}
```
No extra deps — all imports are workspace plugins + `react-icons` (already a root dep).

## Reused APIs (no new code)

| Need | Reuse |
| --- | --- |
| Sidebar entry shape | `sidebarNavItem` — `@plugins/primitives/plugins/app-shell/web` |
| Sidebar slot | `DebugApp.Sidebar` — `@plugins/apps/plugins/debug/plugins/shell/web` |
| Pane register/open/chrome | `Pane`, `openPane`, `PaneChrome` — `@plugins/primitives/plugins/pane/web` |
| Editor component | `BlockEditor` — `@plugins/page/plugins/editor/web` |
| Document list (live) | `documentsResource` + `useResource` — editor `core` / live-state `web` |
| Create document / block | `createDocument`, `createBlock` + `fetchEndpoint` — editor `core` / endpoints `web` |
| Typed block | `textBlock` — `@plugins/page/plugins/text/core` |

## Verification

1. `./equin build` (from this worktree) — regenerates the plugin registry, builds, restarts.
   Confirm no boundary/registry-sync check failures.
2. Open `http://att-1780404278-9gxh.localhost:9000/debug` → click **Page Editor** in the sidebar.
3. Confirm the pane opens with an empty editable text block (auto-created document + block).
4. Exercise the stack: type text, Enter (split → new block + focus moves), Tab (indent),
   Shift+Tab (outdent), Backspace at start (merge), arrow up/down (focus navigation).
5. Reload the page → same document persists (no duplicate documents created). Confirm via MCP
   `query_db`: `SELECT id, title FROM page_documents;` shows exactly one debug document, and
   `SELECT id, type, data FROM page_blocks;` shows the typed text blocks.
6. Scripted check (optional): `bun e2e/screenshot.mjs --url http://att-1780404278-9gxh.localhost:9000/debug --click "Page Editor" --out /tmp/page-debug`.
```

