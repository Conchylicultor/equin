# Code plugin — Step 3: file pane (as a meta-plugin)

## Context

Steps 1 and 2 of the Code plugin shipped: a toolbar button with edited-file
count and a middle-pane file list. Step 3 adds the right-hand pane — the
actual file viewer. The original meta-plugin doc
(`research/2026-04-14-plugins-code-meta-plugin.md`) anticipated a single
`file-pane` sub-plugin, but also hinted that future modes (diff, markdown)
would live alongside it (line 76).

Rather than have each rendering mode contribute independently to `Code.Pane`
and compete at the top level, **the file-pane itself becomes a meta-plugin**
with its own slot for renderers. This keeps the tab-switcher UI, file header,
and selected-file plumbing in one place, while letting each renderer
(Raw / Diff / Markdown) live as an independent sub-plugin with its own deps.

V1 ships the **Raw renderer only**. Diff and Markdown slot in later without
touching the file-pane shell.

## Architecture

```
plugins/…/code/plugins/file-pane/
├── web/
│   ├── index.ts                        # Meta PluginDefinition: contributes to Code.Pane, defines FilePane.Renderer slot
│   ├── slots.ts                        # FilePane.Renderer slot
│   └── components/
│       ├── file-pane.tsx               # Shell: header + tab strip + active renderer body
│       └── renderer-tabs.tsx           # Tabs derived from renderer contributions that support current file
├── package.json
└── plugins/
    └── raw/
        └── web/
            ├── index.ts                # Contributes to FilePane.Renderer with id="raw"
            └── components/raw-view.tsx # Shiki-highlighted file content
```

### The `FilePane.Renderer` slot

```ts
// file-pane/web/slots.ts
export type RendererMatch = 'native' | 'contextual' | 'fallback' | false;

export interface FileRendererContribution {
  id: string;                       // 'raw' | 'diff' | 'markdown' | ...
  label: string;                    // Tab label
  // How well this renderer fits the given file.
  //   'native'     — renders the file in its intended form (Markdown as
  //                  prose, image as image). Format-specific.
  //   'contextual' — relevant to the file's current situation, not its
  //                  format (Diff, when the file has changes vs main).
  //   'fallback'   — always works, bytes-as-text. Raw.
  //   false        — don't show a tab for this file.
  supports(file: { path: string; status: EditedFileStatus }): RendererMatch;
  component: ComponentType<{ path: string }>;
}

export const Renderer = defineSlot<FileRendererContribution>(
  'code.file-pane.renderer',
);
```

Default tab = highest-tier match (`native` > `contextual` > `fallback`).
Within a tier, ambiguity is a design smell — two `native` renderers for
`.md` shouldn't exist; if they do, fail loudly rather than tiebreak with
numbers.

Each renderer reads file content itself via the shared
`useFileContent(path)` hook (from the meta `code` plugin). The pane shell
does not fetch content — that keeps renderers free to fetch different
representations (raw text, unified diff, rendered HTML) from different
endpoints.

### Tab-based switcher

`file-pane.tsx`:

1. Reads `selectedFile` from the shared Code store.
2. Reads all `FilePane.Renderer` contributions.
3. Filters by `supports(selectedFile)`, sorts by `priority` desc.
4. Active tab = user's last explicit choice (kept in local state keyed by
   file path) else the highest-priority supported renderer.
5. If `selectedFile` is null → render empty-state ("Select a file").

Tabs are a small strip in the pane header, alongside the file path and a
copy-path button. Use the existing shadcn `Tabs` primitive if present; else
a lightweight inline implementation (mirrors the Logs tab strip pattern
from commit `b5287ab`).

### Raw renderer sub-plugin

`raw/web/index.ts` registers:

```ts
Renderer.contribute({
  id: 'raw',
  label: 'Raw',
  supports: () => 'fallback',
  component: RawView,
});
```

`RawView` is Step 3's actual rendering work:

- `useFileContent(path)` — shared TanStack Query hook in the meta plugin.
- Lazy-import `shiki/bundle/web` on first render; cache the highlighter
  instance at module scope.
- Detect language from extension (small map; fall back to `text`).
- Render highlighted HTML via `dangerouslySetInnerHTML` on a `<pre>` inside
  a scroll container.
- Theme: `github-dark-default` (matches existing dark UI).
- Show a subtle loading state while Shiki loads / content fetches.

Bundled-highlighter langs: `ts tsx js jsx go json md css sh html yaml`.
Keep curated — a broader set balloons bundle size.

### Shared hook: `useFileContent`

Add to the meta plugin (`code/web/use-file-content.ts`) — already planned
in the original doc. Wraps `GET /api/conversations/:id/file?path=<rel>`
which returns `{ content, language }`. Cached by `[conversationId, path]`.
No `refetchInterval` — re-fetch only on file selection change or explicit
invalidation.

### Server endpoint

`GET /api/conversations/:id/file?path=<rel>` — already spec'd in the
original meta-plugin doc (lines 136–141). Path-traversal guard:
`resolve(worktreePath, path).startsWith(worktreePath)`. Reject binaries
above a size threshold (e.g. 2 MB) with a typed error the renderer can
show ("File too large to preview").

## Layout changes

`code-container.tsx` (meta plugin) already lays out the resizable split.
Step 3 replaces the right panel's placeholder with `Code.Pane`
contributions rendered stacked — in practice only the `file-pane`
contribution renders. No split-layout changes.

## Critical files

Create:
- `plugins/…/code/plugins/file-pane/web/index.ts`
- `plugins/…/code/plugins/file-pane/web/slots.ts`
- `plugins/…/code/plugins/file-pane/web/components/file-pane.tsx`
- `plugins/…/code/plugins/file-pane/web/components/renderer-tabs.tsx`
- `plugins/…/code/plugins/file-pane/plugins/raw/web/index.ts`
- `plugins/…/code/plugins/file-pane/plugins/raw/web/components/raw-view.tsx`
- `plugins/…/code/web/use-file-content.ts`
- Package.json files for the two new plugins.

Modify:
- `plugins/…/code/server/index.ts` — add `/file` route.
- `plugins/…/code/shared/protocol.ts` — `FileContent` type + zod schema.
- `plugins/…/code/web/components/code-container.tsx` — render `Code.Pane`
  contributions in right panel.
- `web/src/plugins.ts` — register `file-pane` meta + `raw` sub-plugin.
- `web/package.json` — add `shiki`.

Reuse:
- `defineSlot` / `defineCommand` from `plugin-core/` — same pattern as the
  existing `Code.ToolbarButton` and `Code.FileList` slots.
- Shiki tab-strip pattern from the Logs plugin (`b5287ab`).
- Shadcn `Tabs` primitive if already present in `web/src/components/ui/`.

## Future renderers (out of scope for v1)

- **Diff**: sub-plugin at `file-pane/plugins/diff/`. `supports` returns
  `'contextual'` when `status !== 'untracked'`, else `false`. Fetches
  unified diff from a new endpoint `/api/conversations/:id/file-diff?path=…`.
  Rendering lib TBD (`diff2html` or hand-rolled).
- **Markdown**: sub-plugin at `file-pane/plugins/markdown/`. `supports`
  returns `'native'` for `.md` / `.mdx`, else `false` — so it becomes the
  default tab for markdown files, Diff stays reachable when there are
  changes, Raw is always reachable.

Both slot in without changes to the file-pane shell or Raw renderer.

## Verification

1. `./equin build` succeeds.
2. Open `http://claude-1776186725.localhost:9000`, pick a conversation with
   edited files, open the Code panel.
3. Click a `.ts` file → pane shows tab strip with a single "Raw" tab, file
   path in header, Shiki-highlighted content in a scroll container.
4. Click a `.md` file → still "Raw" only (v1). Content rendered with
   Markdown syntax highlighting, not prose rendering.
5. Switch files → content updates, scroll resets.
6. `curl '.../file?path=../../etc/passwd'` → 400.
7. Very large file → graceful "too large" message, no browser freeze.
8. Empty state when no file is selected.
9. Bundle size: verify Shiki is in a lazy chunk (check `web/dist` output).
