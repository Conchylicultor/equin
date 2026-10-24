# Single-line as a container property: ambient-context text truncation

## Context

The `27a86e8de` "drain no-adhoc-layout allowlist to 0" refactor migrated ~471 files
from raw flex onto the layout primitives. In the process it introduced a class of
wrapping regressions — two reported surfaces:

- **Element-picker chip** (`ui-context-chip.tsx`): the label `<Text variant="label">…</Text>`
  was moved into `Frame content=` as a **node**. `Frame.FlexSlot` only auto-truncates
  **string** children (wraps them in `<TruncatingText>`); a node gets a bare
  `<div className="min-w-0">` with no nowrap → the label wraps.
- **Conversation second row** (`conversation-item.tsx`): `content={<ChipsSlot/>}` renders
  multiple chips with **no row container** → they wrap.

These are not isolated bugs. The root cause is a **mis-factored primitive**: truncation
was made a *separate component* (`TruncatingText`) from the *text leaf* (`Text`), so a
typed label can be styled **or** single-line, never both in one box. Anyone migrating a
`<Text className="truncate">` naturally keeps the `<Text>` and silently loses truncation.
There are **40** hand-applied `<Text className="truncate">` sites and **11**
`content={<Text/TruncatingText>}` sites today — the trap is already widespread.

### The mental model

Whether text wraps is **not a property of the text** — the same `<Text>` is correct in a
paragraph and broken in a row. It is a property of **where the text lives**, and that is
owned by the **container**. Containers come in two kinds:

- **Line containers** (`Frame`, `Row`, `Bar`, `Badge`, collapsible headers) — single-line
  **by contract**. They guarantee single-line *at the boundary you can't forget* (using
  the slot **is** the opt-in).
- **Flow containers** (`Stack`, `Column`, `Cluster`, `Inline`) — multi-line OK. Text wraps;
  they **reset** the single-line guarantee.

Two layers implement the guarantee (mirroring the existing `region-line` + leaf split):

1. **Structural guarantee (CSS, inherited):** `region-line` (`whitespace-nowrap`) on the
   line container stops **all** descendant text from wrapping — `Text` or raw string or
   inline chip. Already present on `Row`/`Bar`/`Badge`; **missing on `Frame`**.
2. **Ellipsis polish (context, on the leaf):** a `SingleLine` React context (exact mirror
   of `ControlSize`). Line containers provide `true`, flow containers provide `false`;
   `Text` reads it and ellipsizes (`inline-block max-w-full min-w-0 truncate`). **No
   on/off prop on `Text`** → misuse is structurally impossible.

`TruncatingText` dissolves into `Text` (its `side="start"` RTL behavior folds in as a
non-on/off `side` prop). A second, independent axis — **group wrap** (a *group* of chips
wrapping) — is owned by container choice: `Cluster` (wraps) vs `Inline`/`Row` (nowrap);
`white-space:nowrap` does not stop flex-wrap, so this is a separate fix.

### Decisions (confirmed)

- **No escape hatch.** `Text` has zero truncation prop. "Non-truncating text in a line
  container" is a contradiction — use a flow container (which resets the context). Every
  wrapping need is served by choosing the right container.
- **Alias, then delete.** Keep `TruncatingText` as a thin deprecated alias during the
  codemod so each step stays green; delete last. **File a cleanup task** for the deletion.
- **Group-wrap: fix known sites + add a guard** (lint/check) so a multi-chip render slot
  must declare `Cluster` or `Inline`.

## Implementation

### Phase 1 — `SingleLine` context + fold into `Text` (non-breaking)

- **New** `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/single-line.tsx`,
  beside `control-size.tsx` (same below-`Frame` layer). Mirror `ControlSize` exactly:
  ```ts
  const SingleLineContext = createContext<boolean>(false);
  export function SingleLineProvider({ value, children }): …   // Provider, no logic
  export function useSingleLine(): boolean                       // bare useContext
  ```
  Export all from the ui-kit barrel `…/ui-kit/web/index.ts` (next to the ControlSize exports).
- **New internal** `singleLineLeafClass(side?: "end" | "start")` in the `text` plugin —
  the single home for the recipe `inline-block max-w-full min-w-0 truncate` (+ the RTL
  `dir` structure for `side="start"`). This is `TruncatingText`'s body, relocated.
- **`text/web/internal/text.tsx`**: `Text` reads `useSingleLine()`; when `true`, applies
  `singleLineLeafClass(side)`. Add `side?: "end" | "start"` (default `end`) and the
  string→`title` auto-derivation (moved from `truncating-text.tsx:68`). `variant`/`tone`
  unchanged. No truncation on/off prop.
- **`truncating-text/web/internal/truncating-text.tsx`**: becomes a thin **deprecated
  alias** → renders `Text` forced single-line (a local `<SingleLineProvider value>` +
  `Text`, preserving `side`/`as`/`className`). Barrel keeps exporting `TruncatingText`,
  `TruncatingTextProps`, `TruncateSide` so importers stay green.

### Phase 2 — Line containers set, flow containers reset

- **`Frame`** (`css/frame/web/internal/frame.tsx`):
  - Wrap the grid root in `<SingleLineProvider value={true}>` and add the `region-line`
    nowrap guarantee to the root (Frame is grid + owns its own `items-*`, so apply the
    `whitespace-nowrap` half, not the `items-center` half — either a `region-line-nowrap`
    utility or `whitespace-nowrap` directly).
  - **Remove the `typeof children === "string"` branch** in `FlexSlot` (lines 129-135).
    Every cell becomes a uniform `<div className="min-w-0">`. A bare **string** cell wraps
    in the internal single-line leaf (`singleLineLeafClass`) for ellipsis; a **node** cell
    relies on its inner `Text` (now context-truncating) — node and string no longer diverge.
- **`Row`** (`css/row/web/internal/row.tsx:97`) — already `region-line`; wrap root in
  `SingleLineProvider value={true}`. `SectionHeaderRow` inherits.
- **`Bar`** (`primitives/bar/web/internal/bar.tsx:74`) — already `region-line`; add provider.
- **Collapsible** (`collapsible.tsx:86`) + **CollapsibleCard header**
  (`…/collapsible-card.tsx:84`) — already `region-line`; add provider.
- **`Badge`** (`css/badge/web/internal/badge.tsx:66`) — already single-line (`region-line` +
  inner `<span className="truncate">`). **Leave as-is** (label is closed `children`, already
  truncates); no provider needed.
- **Flow containers reset** — `Stack` (`spacing/.../stack.tsx`), `Column`
  (`css/column/.../column.tsx`), `Cluster` (`css/cluster/.../cluster.tsx`), `Inline`
  (`css/inline/.../inline.tsx`): wrap render in `<SingleLineProvider value={false}>` and add
  `whitespace-normal` so a flow region nested inside a line container wraps again (covers the
  two-line list-row label pattern). (`Cluster`/`Inline` delegate to `Stack`; resetting in
  `Stack` may suffice — verify Cluster/Inline don't need their own.)

### Phase 3 — Codemod `TruncatingText` → `Text` (~95 sites / 44 namespaces)

- Mechanical: `<TruncatingText …>` → `<Text …>`, swap the import
  `…/css/plugins/truncating-text/web` → `…/css/plugins/text/web`. Most need no variant
  change (inherit) but `Text` requires a `variant` — pass the nearest sensible variant
  (usually `label`/`caption`/`body`) per call site, OR keep `variant` optional-inherit (decide
  during impl; least churn = optional `variant` defaulting to inherit).
- **Tricky cases (hand-migrate):**
  - `side="start"` — **1 site**, `…/jsonl-viewer/file-path/web/components/file-path.tsx:42`
    (also `as="button"`). `Text` keeps `side` → direct.
  - `as=` overrides — **10 sites**: `as="code"` ×8 (`plugin-meta/facets/*/render-detail`),
    `as="div"` (`data-table.tsx:104`), `as="h2"` (`pages/history/…/page-version-preview.tsx:62`),
    `as="button"` (file-path). `Text` already supports `as`.
  - `<Text className="…truncate…">` (**40 sites**) — drop the `truncate`/`min-w-0` (now
    automatic in line context); keep coloring/weight classes. e.g.
    `pane-chrome.tsx:89`, `conversation-title.tsx:10`, `token-row.tsx:81`.
- **`content={<Text/TruncatingText>}`** (**11 sites**) — become correct automatically once
  Phase 2 lands (context truncates the node). Verify each; drop now-redundant `truncate`.

### Phase 4 — Group-wrap fix (surface 2) + guard

- **`ChipsSlot`** (`conversation-item.tsx:15-23`) — wrap the `Item.Chips.Render` output in a
  nowrap `<Inline gap="xs">` so chips form a single-line group. (Block-row `content` and the
  `inline` layout both benefit.)
- **Studio Explorer badge slots** (`apps/studio/plugins/explorer/web/components/plugin-tree.tsx:159-167`)
  — wrap `TreeRowBadge.Render` / `TreeRowAccent.Render` in `Inline`/`Cluster` per intent.
- **Guard** — a check/lint (new, under `css/lint` or a `check/`) flagging a render slot whose
  contributions are chips/badges rendered without a `Cluster`/`Inline`/`Row` group wrapper.
  `defineRenderSlot.Render` (`slot-render/web/internal/render-slot.tsx`) adds no container, so
  this is the structural gap to police. (Scope/heuristic to refine during impl.)

### Phase 5 — Delete `TruncatingText` + cleanup

- After Phase 3 drains call sites: delete the `truncating-text` plugin (barrel, internal,
  fixtures). Relocate its lint rule `truncating-text/lint/no-clip-without-nowrap.ts` (keep the
  rule; it still guards raw clip-without-nowrap) into `css/lint` or `text/lint`.
- Update tests/fixtures:
  - `truncating-text/web/__tests__/truncating-text.test.tsx` → rewrite as `text` single-line
    test (default ellipsis, `side="start"`, auto-title).
  - `truncating-text/fixtures/internal/truncating-text-fixtures.tsx` (block-parent-no-op
    geometry fixture) → migrate into the `text`/layout-harness fixture catalog using `Text`.
  - `inline/web/__tests__/inline.test.tsx:29` — update the prose ("the truncation leaf owns
    min-w-0" → `Text`).
- Regen docs: `./equin build` (plugin docs, registries, `plugins-details.md`,
  per-plugin CLAUDE.md). Update the **css skill** `.claude/skills/css/SKILL.md` — the
  "leaves truncate" / `TruncatingText` entry becomes "line vs flow containers; `Text`
  truncates inside line context" and document the two-layer model + group-wrap axis.
- **File a cleanup task** (via `add_task`) to remove the deprecated alias once the codemod is
  complete (done at execution time, not in plan mode).

## Critical files

| File | Change |
| --- | --- |
| `…/css/plugins/ui-kit/web/theme/single-line.tsx` (new) | `SingleLine` context + Provider + hook (mirror `control-size.tsx`) |
| `…/css/plugins/ui-kit/web/index.ts` | export the new context API |
| `…/css/plugins/text/web/internal/text.tsx` | read `useSingleLine()`, add `side`, absorb `TruncatingText` |
| `…/css/plugins/truncating-text/web/internal/truncating-text.tsx` | → deprecated alias, then deleted (Phase 5) |
| `…/css/plugins/frame/web/internal/frame.tsx` | provider + `region-line` nowrap; remove string-magic `FlexSlot` branch |
| `…/css/plugins/row/web/internal/row.tsx`, `primitives/bar/web/internal/bar.tsx`, `collapsible.tsx`, `collapsible-card.tsx` | add `SingleLineProvider value` (region-line already present) |
| `…/spacing/.../stack.tsx`, `css/column`, `css/cluster`, `css/inline` | reset: `SingleLineProvider value={false}` + `whitespace-normal` |
| `conversation-item.tsx`, `studio/.../plugin-tree.tsx` | group-wrap fix (Inline/Cluster) |
| `truncating-text/lint/no-clip-without-nowrap.ts` | relocate to `css`/`text` lint |
| `.claude/skills/css/SKILL.md` | rewrite the truncation / line-vs-flow section |

Reuse: `ControlSize` (`control-size.tsx`) is the context template; `region-line`
(`ui-kit/web/theme/app.css:165`, registry `custom-utilities.ts:42`) is the existing nowrap
utility; `Cluster`/`Inline` are the existing group-wrap containers.

## Verification

- **Type/lint:** `./equin check type-check` and `eslint` clean after each phase.
- **Geometry oracle (the truncation gate):**
  `bun test plugins/primitives/plugins/css/plugins/layout-harness/web/internal/layout-geometry.test.ts`
  — must pass with the migrated `Text`/`Frame` fixtures (it measures real truncation onset in
  headless Chromium).
- **Unit:** `bun test plugins/primitives/plugins/css/plugins/text` and the relocated
  single-line test.
- **The two original surfaces (visual, after `./equin build`):**
  - Element-picker chip: open Improve → pick an element with a long label → chip label
    ellipsizes on one line (no wrap), capped at `max-w-40`.
  - Conversation second row: a conversation with several chips (preprompt + progress +
    dependent-count + op-status) in the narrow sidebar → chips stay on one line, time pinned
    right (no wrap). Screenshot via `bun e2e/screenshot.mjs` at a narrow viewport.
- **Regression sweep:** screenshot a few high-chip-density surfaces (task list rows, conversation
  toolbar header, Studio Explorer tree rows) before/after to confirm no new wrap/clip.
- **Docs in sync:** `./equin check` (plugins-doc-in-sync, plugins-registry-in-sync).
