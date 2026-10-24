# File-pane diff renderer

## Context

The conversation file-pane (`plugins/.../code/plugins/file-pane/`) currently exposes two renderer tabs, `Raw` (syntax-highlighted text, `fallback`) and `Markdown` (`native` for `.md*`). When a user opens a file from the edited-files list they have no way to see what actually changed in the worktree — they have to read the full content and guess.

This adds a third renderer, **Diff**, showing `git diff HEAD -- <path>` for the file — i.e. the cumulative delta between `HEAD` and the working tree (staged + unstaged combined). This matches what will eventually be pushed to `main` regardless of how many commits or staging steps happen in between, which is the diff users actually care about.

Scope is intentionally narrow: single-file diff only, side-by-side display. The chosen library (`react-diff-view`) natively supports unified/inline modes, so broader display options can be flipped on later without re-architecting the plugin.

## Library

**`react-diff-view`** — parses unified-diff text and renders side-by-side or unified view in idiomatic React. Plays well with the existing Shiki highlighter (tokens can be fed in externally). Smallest of the evaluated options; consistent with the `raw` plugin's highlighting stack.

Install at repo root:

```bash
bun add react-diff-view
```

(Shared deps live in the root `package.json` per CLAUDE.md.)

## Files to create

```
plugins/conversations/plugins/conversation-view/plugins/code/
├── server/internal/
│   ├── get-file-diff.ts           # NEW — git diff helper
│   └── file-diff-handler.ts       # NEW — HTTP handler
└── plugins/file-pane/plugins/diff/
    └── web/
        ├── index.ts               # NEW — plugin def + FilePane.Renderer contribution
        ├── use-file-diff.ts       # NEW — hook mirroring use-file-content.ts
        └── components/
            └── diff-view.tsx      # NEW — side-by-side diff UI
```

## Files to edit

- `plugins/.../code/server/index.ts` — register the new route.
- `web/src/plugins.ts` — import and register the diff plugin (mirrors lines 13–14 / 36–37 for `raw` and `markdown`).

## Server

### `get-file-diff.ts`

Mirror `get-edited-files.ts` — same `/usr/bin/git` + `Bun.spawn` pattern already used in this plugin (do not introduce a new git wrapper).

Logic:

1. Validate `path` against the worktree root using `isPathInside` from `get-file-content.ts` (reuse — don't duplicate). Reject traversal / null-byte paths.
2. Ask git for the status of the file first: `git status --porcelain -- <path>`.
   - `??` → untracked → diff with `git diff --no-color --no-index -- /dev/null <abs-path>`. `--no-index` exits `1` when files differ — treat exit `1` as success, anything else as failure.
   - Anything else (including unknown / tracked-clean) → `git diff --no-color HEAD -- <path>`. Exits `0` regardless of whether there is a diff.
3. Return a two-case result (the diff UI doesn't distinguish between error subtypes — one error path is enough; the helper just tags the HTTP status it wants the handler to use):
   ```ts
   type FileDiffResult =
     | { kind: "ok"; diff: string }                              // diff may be "" (no changes)
     | { kind: "error"; status: number; message: string };       // status = HTTP code
   ```

Size cap: reuse `MAX_BYTES = 2 * 1024 * 1024` from `get-file-content.ts`; if diff output exceeds it, return `{ kind: "error", status: 413, message: "diff too large" }`.

### `file-diff-handler.ts`

Near-verbatim copy of `file-content-handler.ts` (`plugins/.../code/server/internal/file-content-handler.ts:6-40`): pull `id` param, pull `path` query, look up `worktreePath` via drizzle, call `getFileDiff`, then either `Response.json({ diff })` on `ok` or `new Response(message, { status })` on `error`.

### Route registration

In `plugins/.../code/server/index.ts` add:

```ts
httpRoutes: {
  "GET /api/conversations/:id/file": handleFileContent,
  "GET /api/conversations/:id/diff": handleFileDiff,   // ← new
},
```

## Frontend

### `use-file-diff.ts`

Copy of `plugins/.../file-pane/web/use-file-content.ts` with:

- URL: `/api/conversations/${conversationId}/diff?path=${encodeURIComponent(path)}`.
- State shape: `{ kind: "loading" } | { kind: "ok"; diff: string } | { kind: "error"; status: number; message: string }`.

Don't over-abstract — two near-identical hooks is fine; they fetch different endpoints with different response shapes.

### `diff-view.tsx`

```ts
export function DiffView({ conversationId, path }: { conversationId: string; path: string }) {
  const state = useFileDiff(conversationId, path);
  // loading / error placeholders identical to raw-view.tsx / markdown-view.tsx
  // on ok: parseDiff(state.diff) → <Diff viewType="split" diffType=... hunks={...} />
}
```

Notes:

- Use `parseDiff` from `react-diff-view` to turn the raw unified diff into file/hunk objects.
- Empty diff (`state.diff === ""`) → friendly placeholder ("No changes vs HEAD").
- `viewType="split"` gives side-by-side.
- Import the library's CSS once: `import "react-diff-view/style/index.css";` at the top of `diff-view.tsx`. Tailwind overrides live alongside in the component.
- Syntax highlighting via Shiki is **out of scope** for this first pass (library works without it). A follow-up can call `getHighlighter()` from `raw/web/highlighter.ts` and pass tokens through `react-diff-view`'s `tokenize` helper.

### Plugin definition — `diff/web/index.ts`

Mirror `raw/web/index.ts` and `markdown/web/index.ts`:

```ts
const diffPlugin: PluginDefinition = {
  id: "conversation-code-file-pane-diff",
  name: "Conversation: Code — Diff renderer",
  description: "Side-by-side diff of the file vs HEAD in the conversation's worktree.",
  contributions: [
    FilePane.Renderer({
      id: "diff",
      label: "Diff",
      // contextual = below Markdown (native), above Raw (fallback)
      supports: (file) =>
        file.status === "modified" || file.status === "added" ||
        file.status === "deleted"  || file.status === "untracked"
          ? "contextual"
          : false,
      component: DiffView,
    }),
  ],
};
```

(`status` currently only has those four values, so the match is effectively "always" — but spelling them out makes the intent explicit and fails closed if new statuses are added.)

### Register

Add to `web/src/plugins.ts` alongside the existing renderer imports:

```ts
import conversationCodeFilePaneDiffPlugin from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web";
// ...
export const plugins: PluginDefinition[] = [
  // ...
  conversationCodeFilePaneRawPlugin,
  conversationCodeFilePaneMarkdownPlugin,
  conversationCodeFilePaneDiffPlugin,
];
```

## Future display modes

`react-diff-view` already exposes `viewType` (`"split" | "unified"`) and `diffType` options. The first follow-up only needs a local segmented control inside `DiffView` to swap `viewType`. If/when a distinct display becomes plugin-worthy (inline hunk browser, split-with-minimap, etc.), promote `DiffView` to host a local slot at that point — don't design the slot pre-emptively.

## Verification

1. `./equin build` — must pass (drizzle migrations unchanged; bundler picks up the new plugin).
2. Open `http://claude-1776337403.localhost:9000`, pick a conversation with edited files, click one. New **Diff** tab appears alongside Raw (and Markdown if `.md`); tab order = Markdown → Diff → Raw.
3. Manually exercise each file status by modifying/adding/deleting/creating-untracked files in a conversation's worktree:
   - **modified**: shows standard diff hunks.
   - **added** (committed on branch but not on `main`): shows whole file as additions.
   - **deleted**: shows whole file as deletions.
   - **untracked**: shows whole file as additions (via `--no-index`).
4. Sanity-curl the endpoint directly:
   ```
   curl "http://localhost:3000/api/conversations/<id>/diff?path=README.md"
   ```
   — confirm 200 + `{diff: "..."}` for changed files, empty `diff` for unchanged, 400/404 on bad inputs.
5. Path-traversal probe: `?path=../../etc/passwd` must return 400.
6. Take a screenshot with Playwright for the record:
   ```
   bunx playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" http://claude-1776337403.localhost:9000/c/<id> /tmp/diff-view.png
   ```

## Explicit non-goals

- No syntax-highlighted diff (Shiki integration deferred).
- No multi-file diff view.
- No alternative bases (`main`, specific commits, branches) — always `HEAD`.
- No internal `Diff.Mode` slot — library-level `viewType` covers near-term needs.
