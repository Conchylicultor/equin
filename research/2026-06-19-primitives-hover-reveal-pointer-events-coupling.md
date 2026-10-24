# Couple opacity↔pointer-events on hover-reveal sites (kill invisible click-targets)

## Context

Several hover-reveal sites paint a trailing action cluster with bare
`opacity-0 group-hover:opacity-100` **without** coupling `pointer-events`. At rest
the cluster is invisible but still a live hit-target, so a click on the blank
strip beside the row content silently fires an unseen action. This is a real UX
bug (phantom clicks) and a recurring footgun — a repo-wide scan found **~30**
offending sites, not just the 3 originally reported.

The repo already owns the correct coupling in two places, but neither fits the
pure-CSS `group-hover` case that most offenders use:

- `plugins/primitives/plugins/hover-reveal` — `hoverRevealClass(revealed)` couples
  opacity↔pointer-events, but is driven by a **JS hook** (`useHoverReveal`), i.e.
  React state + pointer handlers. Converting CSS-only reveals to stateful React is
  heavy and changes runtime behavior (re-renders on hover).
- `plugins/primitives/plugins/row-actions` — couples via a **fixed private named
  group** `group/row-actions`, but is an opinionated `Pin`'d cluster of
  `RowActionButton`s, not a generic reveal wrapper.

**Tailwind constraint** that shapes the fix: a generic helper parameterized by group
name (`group-hover/${name}:opacity-100`) produces dynamic class strings Tailwind
cannot statically extract, so the CSS is never generated. The only group-hover-safe
structural primitive is one with a **fixed, private group name** whose classes are
static literals — exactly how `row-actions` already works.

Intended outcome: a generic, pure-CSS reveal primitive that structurally couples
opacity↔pointer-events for any element; a lint rule that bans the bare uncoupled
pattern repo-wide so the class of bug cannot recur; the 3 named offenders migrated;
and the remaining offenders parked in a burndown allowlist with a drain task (mirrors
the existing `no-adhoc-layout` allowlist-drain workflow).

## Approach

### 1. New primitive: generic CSS-group reveal (in `hover-reveal`)

`hover-reveal` is the right home — its stated purpose is "couple opacity with
pointer-events so a hidden control is never a live click-target." Add a **pure-CSS,
fixed-group** variant alongside the existing JS hook (additive, no change to the
current API).

New file `plugins/primitives/plugins/hover-reveal/web/internal/group-reveal.ts`:

```ts
// Anchor: put on the element whose hover/focus should reveal the target.
export const hoverRevealGroup = "group/hover-reveal";

// Target: put on the element to reveal. opacity AND pointer-events are coupled,
// so the hidden state can never be a live click-target. Static literals → Tailwind
// extracts them; the `hover-reveal` group name is private (never collides with a
// consumer's own group).
export const hoverRevealTarget =
  "opacity-0 pointer-events-none transition-opacity " +
  "group-hover/hover-reveal:opacity-100 group-hover/hover-reveal:pointer-events-auto " +
  "group-focus-within/hover-reveal:opacity-100 group-focus-within/hover-reveal:pointer-events-auto";
```

Re-export both from `plugins/primitives/plugins/hover-reveal/web/index.ts` (barrel
purity preserved — only re-exports of own internal file). Multiple named groups can
coexist on one element, so a consumer that already has its own `group/foo` simply adds
`hoverRevealGroup` next to it.

### 2. Lint rule: ban the uncoupled pattern (structural prevention)

New sub-plugin mirroring `button-safety`'s structure:

```
plugins/framework/plugins/tooling/plugins/lint/plugins/hover-reveal-safety/lint/
  index.ts                       # { name, rules, ignores }
  no-uncoupled-hover-reveal.ts   # the rule
```

`index.ts` default export:

```ts
import rule from "./no-uncoupled-hover-reveal";
export default {
  name: "hover-reveal-safety",
  rules: { "no-uncoupled-hover-reveal": rule },
  ignores: { "no-uncoupled-hover-reveal": [ /* burndown allowlist, see step 4 */ ] },
};
```

Rule logic (ESLint v9, `@typescript-eslint/utils`, **no** type info needed):
- Visit `JSXAttribute` where `name === "className"`.
- Recursively collect every string `Literal.value` and template `TemplateElement`
  cooked/raw under the attribute value (handles `cn(...)` args, conditionals,
  template literals — e.g. config-field-row splits the tokens across two `cn` args).
  Concatenate with spaces.
- Flag when the combined string has **all** of:
  - a standalone `opacity-0` token: `/(^|\s)opacity-0(\s|$)/`
  - a group reveal toward non-zero opacity:
    `/group-(hover|focus-within)(\/[\w-]+)?:opacity-(?!0)/`
  - and **no** `pointer-events` token: `!/pointer-events-/`
- Message: name the fix — apply `hoverRevealTarget`/`hoverRevealGroup` from
  `@plugins/primitives/plugins/hover-reveal/web`, or couple
  `group-hover:pointer-events-auto` + `pointer-events-none` by hand.

This passes the two existing primitives (both contain `pointer-events-*`) and any
already-coupled site. Adding `pointer-events-none` to a non-interactive faded element
(e.g. a badge) is harmless, so the rule is safe to apply universally.

### 3. Migrate the 3 named offenders onto the primitive

Each: add `hoverRevealGroup` to the anchor (next to any existing group) and replace
the bare reveal string with `hoverRevealTarget`.

- `plugins/primitives/plugins/data-table/web/internal/data-table.tsx`
  - row div (L83): add `hoverRevealGroup` alongside `group/dt-row`.
  - actions wrapper (L112): replace `opacity-0 transition-opacity group-hover/dt-row:opacity-100 focus-within:opacity-100`
    with `cn("flex items-center justify-end gap-xs", hoverRevealTarget)`.
- `plugins/primitives/plugins/data-view/plugins/gallery/web/components/data-card.tsx`
  - Card root (L43): add `hoverRevealGroup` to the `group` class (replace bare `group`).
  - overlay (L53-56): swap the reveal string for `hoverRevealTarget`.
- `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx`
  - row div (L92): add `hoverRevealGroup`.
  - reset `<button>` (L109-120): replace `opacity-0 transition-opacity` + the
    `isModified && "group-hover:opacity-100"` conditional with `hoverRevealTarget`,
    keeping the `isModified` gate by only applying the reveal target when modified
    (when not modified, keep it hidden+non-interactive). Net: the reset button is no
    longer a phantom click-target.

### 4. Burndown allowlist + drain task for the remaining ~27 sites

Seed `ignores["no-uncoupled-hover-reveal"]` with every other offender file from the
scan (list below) so the `eslint`/`type-check` check stays green. File a follow-up
task (via `add_task`) to drain the allowlist by migrating each site onto
`hoverRevealTarget`/`hoverRevealGroup` (or `row-actions` where it's an icon-button
cluster), removing entries as they're fixed — mirroring the `no-adhoc-layout` drain.

Remaining offenders to allowlist (from the repo scan; verify with `eslint` after the
rule lands and reconcile any the rule additionally surfaces):

```
plugins/apps/web/components/app-tab-bar.tsx
plugins/apps/plugins/surface/plugins/solo/web/solo-placement.tsx
plugins/apps/plugins/pages/plugins/page-tree/web/components/page-header.tsx
plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx
plugins/apps/plugins/pages/plugins/page-tree/web/components/page-cover.tsx
plugins/page/plugins/editor/web/components/block-row.tsx
plugins/page/plugins/bookmark/web/components/bookmark-block.tsx
plugins/page/plugins/video/web/components/video-block.tsx
plugins/page/plugins/file/web/components/file-block.tsx
plugins/page/plugins/audio/web/components/audio-block.tsx
plugins/page/plugins/image/web/components/image-block.tsx
plugins/page/plugins/embed/web/components/embed-block.tsx
plugins/reorder/plugins/editor/web/internal/items.tsx
plugins/tasks/plugins/attempt-view/web/components/attempt-pane.tsx
plugins/tasks/plugins/task-draft-form/web/components/chain-connector.tsx
plugins/tasks/plugins/task-description/web/components/description-view.tsx
plugins/layouts/plugins/miller/web/components/resize-handle.tsx
plugins/primitives/plugins/multi-select/web/internal/selection-checkbox.tsx
plugins/primitives/plugins/text-editor/plugins/paste-images/web/components/attachment-thumbnail.tsx
plugins/active-data/web/internal/active-data-inline-node.tsx
plugins/conversations/plugins/conversations-view/web/components/conv-count-label.tsx
plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/group-box.tsx
plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/group-container.tsx
plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx
plugins/review/plugins/plugin-changes/plugins/file-changes/web/components/file-changes-section.tsx
plugins/review/plugins/code-review/web/components/review-file-row.tsx
plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/internal/event-action-context.tsx
plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/unknown/web/components/unknown-row.tsx
plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web/components/generic-attachment-view.tsx
plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web/components/file-path.tsx
plugins/apps/plugins/sonata/plugins/library/web/components/song-card.tsx
plugins/primitives/plugins/launch/web/components/launch-control.tsx
```

(The `tree-row-chrome` chevron/connector and `task-draft-card` drag indicator are
non-interactive and already carry `pointer-events-none` on the element, or use a
`w-0` collapse trick — re-check against the final rule; allowlist only if the rule
surfaces them.)

## Files to create / modify

Create:
- `plugins/primitives/plugins/hover-reveal/web/internal/group-reveal.ts`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/hover-reveal-safety/lint/index.ts`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/hover-reveal-safety/lint/no-uncoupled-hover-reveal.ts`

Modify:
- `plugins/primitives/plugins/hover-reveal/web/index.ts` (re-export new constants)
- `plugins/primitives/plugins/data-table/web/internal/data-table.tsx`
- `plugins/primitives/plugins/data-view/plugins/gallery/web/components/data-card.tsx`
- `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx`

## Verification

1. `./equin build` — regenerates the lint registry (`lint.generated.ts` picks up
   the new `lint/index.ts`), builds, and runs checks. The `type-check`/`eslint` check
   must be green: the 3 migrated sites pass, the rest are allowlisted.
2. `bunx eslint plugins/primitives/plugins/data-table` (and the gallery/config files)
   — confirm **no** `hover-reveal-safety/no-uncoupled-hover-reveal` violations remain.
3. Re-introduce a bare `opacity-0 group-hover:opacity-100` in a scratch className and
   confirm the rule fires (then revert) — proves the rule actually catches the class.
4. Manual UX check at `http://<worktree>.localhost:9000`: open a DataTable view and a
   gallery view, click the **blank strip** where the hidden actions sit — confirm
   nothing fires at rest, and the actions appear + are clickable on row/card hover.
   Check the Settings → config rows: the reset button only reacts when hovering a
   modified row.

## Out of scope (follow-up task)

Draining the allowlist (step 4) — migrate the remaining ~27 sites onto the shared
primitive in a dedicated pass to keep this PR's review surface focused on the
primitive + rule + headline fixes.
