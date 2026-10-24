# Website Improve: point at the part you mean

## Context

The Improve popover on the equin website (header button, from
`research/2026-09-11-plugins-website-improve-button.md`) has a plain text field.
A visitor can't point at the part of the page they mean. Singularity's own
Improve can: "Pick UI element" puts an outline over the page, you click an
element, and a `<ui-context/>` chip lands in the text at the caret. That
follow-up was filed as `task-1789122717775-lj8anm`.

This plan brings the same experience to the website:

- The text field stays the real Lexical `TextEditor`.
- **Point at the part you mean** runs the real picker (hover outline, click to
  pick).
- The pick lands at the caret as the real `<ui-context/>` chip.
- The GitHub issue that "File it" opens carries what was picked.

### Why this is more than adding a button

The website ships as its own `website` composition. Anything the website imports
is built into that composition, so it cannot reach tasks, conversations, auth,
Singularity's Improve app, `active-data` or the page editor. Today two things
block it:

1. **The picker lives in the wrong place.** The overlay, its hit-testing, the chip
   and the lineage stamping (which tells a pick its plugin and slot) all sit in
   `improve/element-picker`. That plugin's barrel imports `tasks/task-draft-form`,
   `improve/web` and `shell/action-bar`.
2. **The chip can only reach the editor through `active-data`.** `active-data`
   collects every inline chip into one Lexical node and registers it with the
   text editor. Its barrel also registers into the page editor, and it exports a
   hook that reads and writes the server.

There is also a constraint that a quick fix would break. The website is **also**
an app inside the main Singularity composition, where `active-data` and the
picker are present. The text editor's list of token types is global. If the
website registered its own `<ui-context>` token, the main app would have two
registrations for the same characters. So there has to be **one** registration,
owned by a plugin that both compositions can load.

## Decisions (from the user)

- **While picking, the popover hides and comes back.** The whole page is then
  pickable. The popover stays mounted, so after the click it reappears with the
  caret where it was and the chip inserted there.
- **Issue format:** the text stays readable. The raw tag goes in a collapsed
  block, so it is there for an agent but out of a person's way. Assumption: the
  user wrote "wrapped inside a `<summary>`". A block that collapses on GitHub is
  `<details><summary>…</summary>…</details>`, where the summary is the visible
  line and the tag is the hidden body. Inside that body the tag must also sit in
  a code fence, or GitHub strips it.

## Design

Three parts. The first two are extractions, and the third is the feature.

### 1. `primitives/text-editor/plugins/inline-chip`: inline chips without `active-data`

This moves `active-data`'s inline-chip machinery, unchanged, into a backend-free
sub-plugin of `text-editor`. It is built from the editor's token machinery, and it
sits beside `paste-images` and `token-extension`, which also add token types to
the editor. It is pure code: a module registry, one generic Lexical node, a
renderer and an error boundary.

- **Moves** from `plugins/active-data/web/internal/`:
  - `inline-registry.ts`: `inlineChip`, `inlineChips`, `inlineChipFor`,
    `ChipSurface`, and the brand symbol.
  - `inline-extension.ts`: becomes `inlineChipExtension(surface)`.
  - `render-inline-chip.tsx`, `chip-boundary.tsx`.
  - `active-data-inline-node.tsx`: becomes the decorated web node, exported and
    typed, because active-data's page-editor bridge needs it.
  - `register-node-source.ts`: the text-editor `"transcript"` source, kept as a
    side-effect import in the barrel.
- **The node moves too.** `plugins/active-data/core/node.ts` goes to
  `inline-chip/core/`. **The Lexical type string stays `"active-data-inline"`**,
  because it is saved in page docs (and written literally in
  `block-text-write/.../block-doc-text.test.ts`). Only the TypeScript names
  change: `inlineChipNode` / `inlineChipWebNode`.
- **A declaration slot of its own.** `InlineChip.Tag` is a
  `defineSlot<InlineChipContribution>` with `docLabel: p => p.id`, and slot id
  `primitives.text-editor.inline-chip.tag`. `display: "inline"` goes away, since the slot
  holds nothing else. `ActiveData.Tag` shrinks to block | code. Its two runtime
  readers (`segment-active-data.ts`, `use-code-candidates.ts`) already filter by
  `display`.
- **What stays in `active-data`:**
  - block and code tags, the claim protocol, bindings, identity context.
  - the markdown enhancer, the inline-text walker, and linkify, which now reads
    `inlineChips` / `renderInlineChip` from `inline-chip`.
  - `register-block-text-source.ts`, its page-editor bridge, now built on
    `inlineChipExtension("document")` and `inline-chip`'s web node. It stays
    here, not in page/editor, so that the page-editor host still names no chip
    family (see `no-token-identity-outside-owner`).
  - the `active-data:document-chip-has-server-token` check. `TAG_SLOT` becomes
    `primitives.text-editor.inline-chip.tag`, the `display` filter goes, and the hint's
    import path changes.
- **No forwarding.** `active-data` stops exporting `inlineChip`, `inlineChips`,
  `renderInlineChip`, `activeDataInlineExtension` and `ChipSurface`, because
  cross-plugin re-exports are banned. Every consumer imports `inline-chip`.
- **Mechanical retargets:**
  - The web barrels of `attempt`, `conv`, `page-link`, `prototype` and
    `task-link` change from `ActiveData.Tag(inlineChip(…))` to
    `InlineChip.Tag(inlineChip(…))`.
  - The server barrels of `attempt`, `conv`, `prototype` and `task-link` import
    `inlineChipNode` from `inline-chip`'s core. They stay co-owners of the node
    under `no-token-identity-outside-owner`, which grants ownership to anyone
    who registers the node via `Editor.InlineToken`.
- **The meaning of `ChipSurface` "transcript" is restated, not changed.** It
  means every `TextEditor`, plus the markdown and user-text read surfaces: drafts
  and messages addressed to an agent. The website's Improve draft fits. Task
  descriptions already get "transcript" chips today, because the editor registry
  is global.

### 2. `primitives/ui-context/plugins/element-picker`: pick an element and get a token

This holds the generic half of `improve/plugins/element-picker`. Everything here
imports only primitives today. It nests under `ui-context` because it is built
from that plugin: it makes the lineage stamps, collects them into a pick, and
draws the `<ui-context>` token as a chip.

- **Moves:**
  - `picker-overlay.tsx`
  - `internal/resolve-target.ts`
  - `internal/marker-middleware.tsx`. Still a side-effect import, so it is still
    **opt-in**: the cost of stamping every slot contribution is paid only where
    this plugin is in the composition.
  - The chip: `ui-context-tag.tsx`, `ui-context-chip.tsx`, `lineage-path.tsx`,
    contributed as
    `InlineChip.Tag(inlineChip({ id: "ui-context", pattern: UI_CONTEXT_RE, surfaces: ["transcript"], component: UiContextTag }))`.
- **Why the chip lives with the picker:**
  - A plugin enters a composition only if someone imports a real symbol from it.
    The website imports the picker, so the chip and the picker must come as one
    package: whoever can make a `<ui-context>` token can also display one.
  - It can't live in the `ui-context` barrel itself, because the chip boundary
    needs `error-boundary`, which already imports `ui-context` (a cycle). As a
    sub-plugin there is no cycle, because the parent never imports its child:
    ui-context ← error-boundary ← inline-chip ← ui-context/element-picker.
  - Crash-provenance tokens from `reports/crash` still render in the main app,
    where this plugin is always present.
- **New API: a component, not a hook that hands back an overlay.** A hook paired
  with "remember to render the overlay" is easy to get half-wrong.

  ```tsx
  <ElementPicker
    onPick={(meta: UiContextMeta) => …}
    onArmedChange?={(armed) => …}
    hint?="Click the part you mean"
    trigger={({ armed, arm }) => <Button onClick={arm}>…</Button>}
  />
  ```

  - While armed, it mounts the overlay and calls `collectMeta` on the click.
  - `hint` renders a pill at the bottom of the overlay reading "Click the part
    you mean · Esc" with a **Cancel** button. The pill sits inside
    `[data-element-picker]`, so the hit-testing skips it.
  - `PickerButton` (the `IconButton` form, still disabled while armed) is built
    on `ElementPicker`.
- **`improve/element-picker` shrinks to Singularity glue:** the `ActionBar.Item`
  and the `TaskDraftFormSlots.Action`, both built on `PickerButton` from
  `ui-context/element-picker`.
- **The `vite/` source-location transform stays where it is.** It is found by a
  filesystem walk, not by composition, so website elements already carry
  `data-source` and `data-ui-owner`. Its CLAUDE.md wrongly says those exist "only
  when the picker is in the composition"; fix that sentence.

### 3. The website's Improve popover

**Picking** (`improve-panel.tsx`, `improve-nav-item.tsx`):

- A **"Point at the part you mean"** button sits under the text field in the
  Compose view, as in the mock. It uses the `MdAdsClick` icon and is built with
  `ElementPicker`.
- `TextEditor` gets an `insertRef`.
- `ImproveNavItem` owns a `picking` flag, which the panel sets through
  `onArmedChange`. While it is set, the popover gets
  `contentClassName="invisible"`: it is hidden but stays mounted, and the
  hit-testing already skips `visibility:hidden`. Closing the popover instead
  would unmount the editor and lose the caret.
- **On a pick:**
  1. Run `flushSync(() => setPicking(false))` **first**. Inserting focuses the
     editor, and focusing an element that is still hidden fails silently.
  2. Then call `insertRef.current(serializeUiContext(meta, "picked"))`.
  3. If the ref is null (Lexical is loaded lazily), append the token to
     `draft.text` instead.
- **On cancel** (Esc or Cancel): show the popover again and give the editor its
  focus back.
- The overlay already swallows `pointerdown` and Escape at window capture. So the
  popover does not read a pick as an outside press, and Escape does not close it.

**The issue** (`core/issue-url.ts`, pure and unit-tested):

- **A new helper in `primitives/ui-context/core`**, for example
  `splitUiContext(text)`. It returns the text split into prose and parsed tags,
  and is built on `UI_CONTEXT_RE` internally. The website cannot import that
  pattern itself: `no-token-identity-outside-owner` bans consumers from naming a
  token pattern.
- **The text is made readable:** each tag becomes `` `<element label>` [n] ``.
  The title (`issueTitle`) and the replay's "Task filed" line are built from this
  readable text, never from the raw tag.
- **The body:** the readable text, then the rule, then one collapsed block per
  pick, then the existing lines:

  ````
  Make `h1 — What will apps evolve into?` [1] bigger.

  ---
  <details><summary>[1] h1 — What will apps evolve into?</summary>

  ```html
  <ui-context url="…" plugin="…" path="…" selector="…" source="…"><hint>…</hint><picked-content>h1 — What will apps evolve into?</picked-content></ui-context>
  ```

  </details>

  Page: https://equin.ai/…
  Auto-deploy: no (review first)
  Filed from the Improve button on equin.ai
  ````

- **Staying under the 7,500-character link limit.** A tag is several hundred
  characters, and more once encoded. When the link is too long, give things up
  in this order:
  1. Everything in full.
  2. Drop raw tags, last pick first. That pick keeps a plain `[n] <label>` line.
  3. Cut the visitor's text by bisection, as today.
  4. With the text empty, drop the trailing `[n]` lines and add "+N more".
  5. Throw only when the page URL alone is over the limit (unchanged).

  Each step gets a test in `issue-url.test.ts`.

**The replay:** step 3 ("An agent makes the change") names the first pick's
source file when there is one, as in the mock: "Reads `hero.tsx`, the code behind
what you pointed at". Otherwise it keeps today's line.

## Files

**New** (both nested, no new top-level primitive):
`plugins/primitives/plugins/text-editor/plugins/inline-chip/` and
`plugins/primitives/plugins/ui-context/plugins/element-picker/`, each with `package.json`,
`CLAUDE.md`, `web/index.ts` and `web/slots.ts` (inline-chip), plus `core/` for
inline-chip. Run `bun install` afterwards, since plugins are workspaces.

**active-data:**
- `web/index.ts`, `web/slots.ts`
- `web/internal/linkify-active-data.tsx`
- `web/internal/register-block-text-source.ts`
- `core/index.ts`; delete `core/node.ts`
- `check/index.ts`, `CLAUDE.md` (the "One chip declaration" section moves to
  `inline-chip`)
- The sub-plugin barrels listed in part 1.

**improve/element-picker:** `web/index.ts`, `element-picker-button.tsx`,
`task-draft-picker-button.tsx`, `CLAUDE.md`.

**ui-context:** the split helper and its test, plus a CLAUDE.md fix (the marker
middleware now lives in its `element-picker` sub-plugin).

**Website improve:** `improve-panel.tsx`, `improve-nav-item.tsx`,
`replay-steps.tsx`, `core/issue-url.ts`, `core/index.ts`, `issue-url.test.ts`,
`e2e/improve-verify.ts`, and `CLAUDE.md`. Its import rule becomes "shell +
primitives, including `element-picker` and `ui-context`".

**Tests that move:**
- To inline-chip: `inline-registry.test.ts`, `active-data-inline-copy.test.tsx`,
  `editor-bridge.test.tsx`.
- To `ui-context/element-picker`: `resolve-target.test.ts`,
  `contribution-box-lineage`, `portal-lineage`, `ui-context-chip-fields`.
- `inline-text-walker.test.tsx` retargets to `inline-chip`.
- `ui-context-read-render.test.tsx` stays in `improve/element-picker` and renders
  the real registered chip.

**Comments only:** the `UI_CONTEXT_RE` example in
`page/editor/check/no-token-identity-outside-owner.ts`,
`page/editor/server/internal/block-registry.ts`,
`error-boundary/web/reporter.ts`, `dom/copy-source-text/CLAUDE.md`.

**Regenerated by `./equin build`:** the registries, `web-tiers`, and the
plugin docs / autogen CLAUDE blocks.

## Risks

- **Boot order.** `TextEditor` fixes its Lexical node list when it mounts. If no
  chip has registered by then, the generic node is missing for that editor's
  lifetime. Both new sub-plugins land in the eager tier and the website's Improve
  is deferred, so the chip registers first. Keep them eager.
  (`eager-tier-in-sync` will show it.)
- **One registration.** Only `ui-context/element-picker` calls
  `inlineChip({ id: "ui-context" })`, and a duplicate id throws. So a stray
  second registration fails loudly instead of doubling up.
- **Website closure.** The website gains the two new sub-plugins, `slot-render`
  stamping on its contributions, and what inline-chip imports (text-editor,
  error-boundary, copy-source-text, hover-reveal, css). None of these reach tasks,
  auth or `active-data`. Soft slot contributors (the `active-data` chip
  sub-plugins) are never pulled in by a slot being present.
  `composition-closure` confirms.

## Verification

1. `./equin test plugins/primitives/plugins/text-editor plugins/primitives/plugins/ui-context plugins/active-data plugins/improve plugins/apps/plugins/website/plugins/improve`
2. `./equin check`, which includes `composition-closure`,
   `plugin-boundaries`, `plugins-registry-in-sync` and `eager-tier-in-sync`.
3. `./equin build`, then extend and run `improve-verify.ts`:
   - Open Improve, type text, and put the caret mid-sentence.
   - Click **Point at the part you mean**. The popover is hidden and the hint pill
     shows.
   - Hover the hero headline: the outline follows. Click it.
   - The popover is back with exactly one chip at the caret, and the text on both
     sides is kept.
   - Esc while armed brings the popover back with no chip.
   - **Show me**, then check "File it": the title has no `<ui-context`, the body
     has `[1]`, a `<details>` block, and the tag inside a code fence.
4. Run the same script against the filtered build:
   `./equin build --composition website`, then
   `improve-verify.ts --composition website`. This proves the chip, the picker
   and the lineage (`plugin` / `path` filled) work without `active-data`.
5. Regression in the main app: the existing `improve/element-picker/e2e`
   scripts (`pick-pointer-events-none`, `preserve-draft`, `paste-ui-context`).
   Then spot-check that an `att-…` chip still renders in a page block and in a
   transcript.
