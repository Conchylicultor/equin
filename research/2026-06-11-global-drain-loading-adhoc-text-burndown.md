# Drain `no-adhoc-loading-text` BURNDOWN + retire `Placeholder>Loading…`

## Context

The `no-adhoc-loading-text` lint rule
(`plugins/primitives/plugins/loading/lint/no-adhoc-loading-text.ts`) landed with
~26 grandfathered files in a BURNDOWN allowlist
(`plugins/primitives/plugins/loading/lint/index.ts`). Each hand-rolls a
`Loading…` string inside `<Text>`/`<div>`/`<Spinner>` markup. That text **paints
instantly**, so on the common warm path (live-state resources settle over the WS
in <100ms) it flashes a loading state and then immediately unmounts.

The `<Loading>` primitive (`@plugins/primitives/plugins/loading/web`) exists
precisely to fix this: every variant mounts invisible and fades in only after
~120ms (pure CSS, `web/internal/loading.css`), so fast loads show **no transient
UI at all**. The skeleton only appears on genuinely slow loads.

The same flash affects the **23 `<Placeholder>Loading…</Placeholder>` uses**
scattered across the app. These are *sanctioned* by the lint rule (Placeholder is
the `variant="text"` delegate) so they aren't flagged — but `<Placeholder>` has
no delay-before-show, so they flash exactly like the ad-hoc text. Migrating them
to `<Loading variant="text">` both fixes the flash and restores the intended
division of labor: **`Placeholder` = empty/error states only; `Loading` = the
loading state.**

**Outcome:** every loading indicator routes through `<Loading>` with the right
variant, the BURNDOWN allowlist is empty, and the rule guards an already-clean
tree going forward.

## The `<Loading>` API (reference)

```tsx
<Loading />                               // variant="text" (default) → <Placeholder>Loading…</Placeholder> in a delayed wrapper
<Loading label="Loading plugin tree…" />  // text variant with custom label
<Loading variant="spinner" label="…" />   // spinner + label; root already has `flex items-center gap-2 px-3 py-2`
<Loading variant="rows" count={6} />      // skeleton list rows (default 6), root has `p-2`
<Loading variant="cards" count={8} />     // skeleton card grid (default 8), root has `gap-4 p-6`
<Loading variant="block" className="…" /> // single shimmer block (needs sizing via className)
```

`className` is merged onto the root `loading-delayed` wrapper of every variant —
this is how centering / padding from the old markup is preserved (e.g.
`className="flex h-full items-center justify-center"`).

## Phase 1 — Drain the 26-file BURNDOWN allowlist (required)

One allowlist entry is already stale: **`deploy/servers/web/panes.tsx` already
uses `<Loading variant="rows" />`** (the actual `<Placeholder>Loading…</…>` moved
to the sibling `servers-list.tsx`, handled in Phase 2). So Phase 1 edits **25**
files + removes **26** allowlist entries.

Per-file migration (path relative to repo root; all currently import `Text` from
`@plugins/primitives/plugins/text/web` unless noted):

| # | File | Current | New |
|---|------|---------|-----|
| 1 | `active-data/plugins/plugin-link/web/panes.tsx` | `<Text … flex h-full items-center justify-center>Loading…</Text>` | `<Loading className="flex h-full items-center justify-center" />` |
| 2 | `apps/plugins/deploy/plugins/servers/web/panes.tsx` | already `<Loading variant="rows"/>` | **no edit** — only drop allowlist entry |
| 3 | `apps/…/tables/plugins/columns/web/components/columns-section.tsx` | `<Spinner/>Loading columns…` `px-3 py-2` | `<Loading variant="spinner" label="Loading columns…" />` |
| 4 | `apps/…/tables/plugins/foreign-keys/web/components/foreign-keys-section.tsx` | `<Spinner/>Loading foreign keys…` | `<Loading variant="spinner" label="Loading foreign keys…" />` |
| 5 | `apps/…/tables/plugins/indexes/web/components/indexes-section.tsx` | `<Spinner/>Loading indexes…` | `<Loading variant="spinner" label="Loading indexes…" />` |
| 6 | `apps/…/tables/plugins/row-count/web/components/row-count-section.tsx` | `<Spinner/>Loading…` `px-3 py-2` | `<Loading variant="spinner" label="Loading…" />` |
| 7 | `apps/…/tables/plugins/sample-rows/web/components/sample-rows-section.tsx` | `<Spinner/>Loading sample rows…` | `<Loading variant="spinner" label="Loading sample rows…" />` |
| 8 | `apps/plugins/studio/plugins/contributions/web/components/contributions-view.tsx` | centered `Loading…` | `<Loading className="flex h-full items-center justify-center" />` |
| 9 | `apps/plugins/studio/plugins/explorer/web/components/explorer-view.tsx` | centered `Loading plugin tree…` | `<Loading label="Loading plugin tree…" className="flex h-full items-center justify-center" />` |
| 10 | `backup/web/components/backup-panel.tsx` | inline `Loading…` (history list) | `<Loading variant="rows" />` |
| 11 | `code-explorer/web/components/file-tree-view.tsx` | `Loading…` `px-3 py-2` (file tree) | `<Loading variant="rows" />` |
| 12 | `conversations/…/file-pane/plugins/diff/web/components/image-diff-view.tsx` | `Loading…` `px-3 py-2` | `<Loading className="px-3 py-2" />` |
| 13 | `conversations/…/jsonl-viewer/web/components/jsonl-pane.tsx` | `Loading…` caption `px-3 py-2` | `<Loading className="px-3 py-2" />` |
| 14 | `conversations/…/conversation-view/web/components/conversation-view.tsx` | centered `Loading…` `p-6` | `<Loading className="flex h-full items-center justify-center p-6" />` |
| 15 | `conversations/…/conversations-view/plugins/grouped/web/components/grouped-view.tsx` | pagination `Loading...` `px-4 py-2` | `<Loading variant="spinner" label="Loading…" />` |
| 16 | `conversations/…/conversations-view/plugins/history/web/components/history-view.tsx` | pagination `Loading...` `px-4 py-2` | `<Loading variant="spinner" label="Loading…" />` |
| 17 | `debug/plugins/broadcasts/web/components/broadcasts-panel.tsx` | centered `Loading…` | `<Loading className="flex h-full items-center justify-center" />` |
| 18 | `debug/plugins/memory/web/components/memory-panel.tsx` | centered `Loading…` | `<Loading className="flex h-full items-center justify-center" />` |
| 19 | `page/plugins/editor/web/components/block-editor.tsx` | `Loading...` `px-3 py-2` (block list) | `<Loading variant="rows" />` |
| 20 | `plugin-meta/plugins/plugin-view/web/panes.tsx` | centered `Loading…` (in PaneChrome) | `<Loading className="flex h-full items-center justify-center" />` |
| 21 | `primitives/plugins/icon-picker/web/components/icon-picker.tsx` | (a) inline `<span>· loading…</span>`; (b) `Loading icons…` `py-8 text-center` | (a) **leave as-is** (lowercase annotation, not flagged, intentionally subtle); (b) `<Loading label="Loading icons…" className="py-8 text-center" />` |
| 22 | `review/plugins/plugin-changes/plugins/file-changes/web/components/file-changes-section.tsx` | `Loading…` `px-1` | `<Loading className="px-1" />` |
| 23 | `review/plugins/plugin-changes/web/components/plugin-changes-section.tsx` | `Loading plugins...` `px-1` | `<Loading label="Loading plugins…" className="px-1" />` |
| 24 | `screenshot/web/components/screenshot-view.tsx` | centered `Loading…` (image area) | `<Loading className="flex h-full items-center justify-center" />` |
| 25 | `stats/plugins/commits/web/components/chart-primitives.tsx` | `Loading…` (ChartState loading branch) | `<Loading />` |
| 26 | `ui/plugins/tweakcn/plugins/community-browser/web/components/community-browser-section.tsx` | `Loading themes...` (card grid) | `<Loading variant="cards" />` |

**Variant rationale (per "shaped where it fits"):**
- **spinner** — the five studio table sections (#3–7) already used inline spinners; keep that look. Also the two pagination "load more" sentinels (#15–16) where a small spinner reads naturally.
- **rows** — content that is clearly a vertical list: backup history (#10), file tree (#11), block list (#19).
- **cards** — the tweakcn community card grid (#26).
- **text** (default) — everything else: full-pane/inline plain text and the icon-grid placeholder (#21b — `cards` would be the wrong shape for tiny icon cells).

**Per-file mechanics:**
- Add `import { Loading } from "@plugins/primitives/plugins/loading/web";`.
- Remove now-unused imports (`Text`, `Spinner`, and the local `Placeholder` if it
  becomes unused) — the `type-check` / eslint pass flags unused imports, so this
  is forced, not optional.
- icon-picker (#21) keeps its `Text` import (still used elsewhere) and its
  lowercase `· loading…` span.

**Then** in `plugins/primitives/plugins/loading/lint/index.ts`: drain all 26
entries from the `no-adhoc-loading-text` allowlist. The infra
(`build-lint-config.ts:155-164`) explicitly treats an **empty glob array as a
valid "no exemptions" state** (it filters out empty-`files` configs), so leave
`"no-adhoc-loading-text": []` with a one-line comment noting the burndown is
complete — do NOT delete the key (keeps it documented and prevents silent
re-introduction of an allowlist).

## Phase 2 — Retire `<Placeholder>Loading…</Placeholder>` (23 uses → `<Loading>`)

These are not lint violations but carry the same flash. Default to a clean 1:1
swap to `variant="text"`; use `rows` only for the obvious full-list panes.

`variant="text"` (default `<Loading />`, with `label` where the text differs):
- `debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx:243`
- `agents/web/components/agent-detail.tsx:49`
- `build/plugins/build-commits/web/components/build-commits-section.tsx:12` → `label="Loading commits…"`
- `apps/plugins/deploy/plugins/servers/web/components/servers-list.tsx:15`
- `conversations-recover/web/components/recovery-view.tsx:139`
- `attempt-view/web/components/attempt-pane.tsx:126`
- `config_v2/plugins/settings/web/components/config-nav.tsx:154`
- `config_v2/plugins/settings/web/components/invalid-diff.tsx:17` → `label="Loading diff…"`
- `config_v2/plugins/settings/web/components/conflict-diff.tsx:15` → `label="Loading diff…"`
- `config_v2/plugins/settings/web/components/config-detail.tsx:304`
- `review/plugins/code-review/web/components/code-review-section.tsx:25,55,144` (the `:55` one stays wrapped in `<Body>…</Body>`)
- `primitives/plugins/folder-picker/web/internal/folder-picker.tsx:41`
- `primitives/plugins/pane/web/components/pane-resolve-guard.tsx:46` (inside `FallbackChrome`; its `title="Loading…"` string prop is untouched — not JSX text)
- `conversations/…/commits-graph/web/components/commits-graph-body.tsx:32`
- `conversations/…/commits-graph/web/components/commit-diff-view.tsx:19`
- `conversations/…/file-pane/plugins/raw/web/components/raw-view.tsx:89`
- `conversations/…/file-pane/plugins/diff/web/components/diff-view.tsx:326`
- `conversations/…/file-pane/plugins/markdown/web/components/markdown-view.tsx:18`

`variant="rows"` (clear full-list panes):
- `agents/web/components/agents-list.tsx:166`
- `tasks/plugins/task-list/plugins/recent/web/internal/tasks-recent-view.tsx:32`
- `tasks/plugins/task-list/plugins/tree/web/tasks-list.tsx:180` (the `<ResourceView fallback={…}>` value)

**Mechanics:** swap import `Placeholder` → `Loading` from the loading barrel where
Placeholder becomes unused; keep `Placeholder` imported where the file still uses
it for empty/error states (e.g. files with `<Placeholder tone="error">`).

**Boundary safety:** `loading` only imports `placeholder` + `spinner`, so the new
edges `pane → loading`, `folder-picker → loading`, `icon-picker → loading`
introduce **no cycle** (loading never imports those). All imports use the legal
runtime barrel `@plugins/primitives/plugins/loading/web`.

## Critical files

- `plugins/primitives/plugins/loading/lint/index.ts` — drain allowlist to `[]`.
- `plugins/primitives/plugins/loading/web/internal/loading.tsx` — the primitive (reference only, unchanged).
- 25 Phase-1 component files + 22 Phase-2 component files (listed above).

## Verification

1. `./equin build` — compiles frontend + server, runs checks (incl.
   `type-check` which catches unused imports and the eslint rules).
2. `./equin check eslint` (or the full `./equin check`) — confirm
   `no-adhoc-loading-text` passes with an **empty** allowlist and
   `plugin-boundaries` passes (no new cycles).
3. `rg -n "Placeholder>Loading" --glob '*.tsx' plugins/` → **0 results**.
4. `rg -n ">Loading" --glob '*.tsx' plugins/` → only matches inside `<Loading …>`
   and the intentional icon-picker lowercase `· loading…` span.
5. Visual spot-check via Playwright at `http://<worktree>.localhost:9000` on a
   few migrated surfaces (Studio table sections, a conversation view, the tweakcn
   community browser) — on a normal warm load there should be **no loading flash**
   at all; only a genuinely slow load shows the skeleton/text after ~120ms. Use
   `e2e/screenshot.mjs` to navigate and capture.

## Notes / non-goals

- The icon-picker `· loading…` lowercase span (#21a) is intentionally left — it's
  a subtle inline label annotation during lazy icon-set load, not flagged by the
  rule, and not a full loading-state surface.
- `FallbackChrome title="Loading…"` (pane-resolve-guard) is a string prop, not a
  loading surface — left untouched.
- No schema/DB/migration changes; this is purely a frontend component + lint-config
  refactor.
