# Config: side-by-side diff for "Upstream defaults changed" conflicts

## Context

When `config_v2` detects a **hard conflict** — the upstream origin (defaults) moved
underneath a user override written against an older hash — the settings detail pane
shows a warning banner reading **"Upstream defaults changed"** with two actions:
*Accept all new defaults* and *Keep my values*
(`plugins/config_v2/plugins/settings/web/components/config-detail.tsx:152`).

The problem: the user is asked to choose between their config and the new upstream
defaults **without ever being shown what actually differs**. There is no way to see
the diff between the user's override and the new upstream origin before deciding.

This plan adds a **"View diff"** toggle to that banner that reveals an inline
side-by-side diff of the user's config (override) vs. the upstream defaults (origin).

## Approach

Reuse the existing diff-rendering machinery. There is already a working precedent for
rendering a side-by-side diff of two in-memory strings:
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/edit/web/components/inline-diff.tsx`
(`InlineDiff`) builds hunks from two strings via `structuredPatch` (from the `diff`
package), highlights both sides with shiki, builds per-side token maps via
`buildSideTokenMap`, and renders `DiffRenderer` — all imported cross-plugin from the
`diff` plugin barrel
(`@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web`).

We now have a **second** consumer wanting the exact same "diff two strings"
behaviour (config settings). Rather than duplicate `InlineDiff`'s ~70 lines of
hunk-building + token logic, **extract a reusable `TextDiff` component into the `diff`
plugin** (which already publicly owns `DiffRenderer` + `buildSideTokenMap` and is
already consumed cross-plugin by the `edit` plugin). Both `edit` and `config_v2`
settings then consume `TextDiff`.

This keeps a single source of truth for string-vs-string diffs, reuses the public
generic `DiffRenderer` API exactly as the `edit` plugin already does, and adds no new
plugin. The cross-plugin edge `config_v2.settings → conversations…diff` is consistent
with repo conventions (`plugin.** -> plugin.**` is allowed; no cycle is introduced —
`conversations` imports `config_v2`'s parent barrel, never the `settings` child).

### Data source

The diff data is already available, no new endpoint required. `getConfigRawFile`
(`GET /api/config-v2/raw-file`,
`plugins/config_v2/plugins/settings/core/internal/endpoints.ts:19`) returns
`{ origin, override }` raw JSONC strings — exactly `RawFileView` already fetches in
`config-detail.tsx:192`. During a hard conflict, `origin` is the **new upstream
defaults** and `override` is the **user's stale config**, so:

- diff **old** side = `override` (the user's config)
- diff **new** side = `origin` (the upstream defaults)

Pass `path="config.json"` so shiki highlights as JSON (`.jsonc` is not in
`EXT_TO_LANG`, but `json` is — `plugins/primitives/plugins/syntax-highlight/web/internal/lang.ts:9`).

## Changes

### 1. New shared `TextDiff` component — `diff` plugin

File: `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/diff/web/components/text-diff.tsx` (new)

- Move the `buildHunks(oldText, newText)` helper and the shiki-token `useEffect`
  hook currently inlined in `inline-diff.tsx` into a `TextDiff` component here.
- Props: `{ oldText: string; newText: string; path: string }` (same shape as
  `InlineDiff`). Returns `null` when there is no diff.
- Internally renders `<DiffRenderer files={files} hunks={hunks} tokens={tokens} />`
  using the local `DiffRenderer`/`buildSideTokenMap` (same-plugin imports, no churn).
- Export `TextDiff` from the diff barrel
  `…/file-pane/plugins/diff/web/index.ts`.
- Add `"diff": "^7.0.0"` to the diff plugin's `package.json` dependencies if not
  already present (root `package.json` already declares it; confirm during impl).

### 2. Refactor `edit` plugin to consume `TextDiff` (de-dupe)

File: `…/jsonl-viewer/plugins/tool-call/plugins/edit/web/components/inline-diff.tsx`

- Delete the local `buildHunks`, `themedToTokens`, `useInlineDiffData`, and the
  `structuredPatch`/`buildSideTokenMap`/shiki imports.
- Reimplement `InlineDiff` as a thin wrapper that renders `<TextDiff … />` imported
  from the diff barrel, preserving its current `{ oldText, newText, path }` API so
  `EditView`/`MultiEditView` callers are unchanged.

### 3. Config settings conflict banner — add "View diff" toggle

File: `plugins/config_v2/plugins/settings/web/components/config-detail.tsx`

- In `ConfigDetailInner`, add `const [showDiff, setShowDiff] = useState(false)`;
  reset it in the existing `useEffect` keyed on `registration.storePath`.
- In the **hard-conflict** branch (the `else` at `config-detail.tsx:151`, "Upstream
  defaults changed"), add a **View diff / Hide diff** button alongside *Accept all
  new defaults* / *Keep my values* (same `bg-warning/20` chip styling).
- When `showDiff` is true, render a `<ConflictDiff storePath={registration.storePath} />`
  block below the banner (above the field rows).
- New small component `ConflictDiff` (in a new
  `plugins/config_v2/plugins/settings/web/components/conflict-diff.tsx`):
  - Fetches `getConfigRawFile` via `useEndpoint` (mirrors `RawFileView`).
  - Shows a `Placeholder` while pending / when data missing.
  - Renders a two-label legend ("Your config" ↔ "Upstream defaults") and
    `<TextDiff oldText={override ?? ""} newText={origin ?? ""} path="config.json" />`
    imported from the diff barrel.
  - Wrap in a bordered, scrollable container so a large diff doesn't blow out the pane.

## Critical files

- `plugins/config_v2/plugins/settings/web/components/config-detail.tsx` — banner + toggle (edit)
- `plugins/config_v2/plugins/settings/web/components/conflict-diff.tsx` — diff block (new)
- `…/file-pane/plugins/diff/web/components/text-diff.tsx` — shared component (new)
- `…/file-pane/plugins/diff/web/index.ts` — export `TextDiff` (edit)
- `…/tool-call/plugins/edit/web/components/inline-diff.tsx` — delegate to `TextDiff` (edit)
- `getConfigRawFile` endpoint (reused, no change) — `…/settings/core/internal/endpoints.ts:19`
- `DiffRenderer`, `buildSideTokenMap` (reused) — `…/diff/web/components/diff-view.tsx`, `…/diff/web/use-diff-tokens.ts`

## Verification

1. `./equin build` from the worktree; confirm the boundary/lint/migration
   checks pass (no new cycle; barrel-purity intact). Run
   `./equin check --plugin-boundaries` explicitly.
2. Reproduce a hard conflict for a config: with an existing user override on disk
   under `~/.singularity/config/<tree>/<name>.jsonc`, change the upstream default in
   the plugin's `defineConfig` so the origin hash advances, then `./equin build`.
   Open Settings → the affected config; the "Upstream defaults changed" banner should
   appear.
3. Scripted Playwright run (`e2e/screenshot.mjs`) on
   `http://<worktree>.localhost:9000` Settings pane: click **View diff**, capture
   before/after, confirm the side-by-side diff renders override (left) vs origin
   (right) with JSON syntax highlighting, and **Hide diff** collapses it.
4. Regression: open an Edit/MultiEdit tool call in a conversation's JSONL viewer and
   confirm `InlineDiff` still renders identically after the `TextDiff` refactor.
