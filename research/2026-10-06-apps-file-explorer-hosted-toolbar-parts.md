# File explorer: the folder view's DataView controls go in the explorer toolbar, and a hosted frame can no longer drop a part

## Context

`/files` renders a folder as a DataView tree with a **hosted** toolbar
(`HOSTED` in `plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx`).
The original frame was `({ body }) => body`, so it dropped the options trigger: the only
way to reach sort, filters and fields. Commit 6a617a083e partly fixed this. `FileTreeFrame`
now renders `options`, but in the wrong place: hover-revealed at the listing's top-right,
next to the column header. The frame still drops `switcher` and `creators`. Nothing stopped
either mistake. The `HostedToolbarParts` contract ("the ONLY way to reach them, so render it")
is only written in a comment.

Outcome:
1. The folder view's controls (view switcher when there are 2+ views, creators, options)
   sit in the explorer's own toolbar row, after the Filter field, the Show-hidden toggle and
   the lens toggles. This is the layout from proto-1790864772-0r54. They are always visible,
   like the buttons beside them.
2. The DataView fails loudly when a hosted frame shows its rows without a part the host built.

## Decision (2026-10-06)

The user approved part 2 and the `forms.options` addition, and declined the
guard (part 1's `HostedFrameHost` / `PlacedPart` / verify): the contract stays
documentation-only. Part 1's guard text below is kept as the rejected
alternative; the explorer frame does not hold its body back, since nothing
checks placement.

## Design

### 1. The guard: "rows on screen ⇒ every built part on screen" (data-view, loud runtime)

A type cannot make a frame render a `ReactNode` it was handed. A frame may also
legitimately hide its parts. For example, `OpStatusCard` hides `options` **and** `body`
while it is collapsed. So the rule is about the parts and the rows together: **whenever
the frame mounts `body`, it must also mount every part the host built (non-null).**
A frame that hides its rows may hide its controls too.

Mechanism (`plugins/primitives/plugins/data-view/web/components/toolbar/hosted-frame.tsx`, new):
- `HostedFrameHost` replaces the two direct `<toolbar.frame …/>` calls
  (`data-view-body.tsx` hosted branch, and `withoutInstance` in `data-view.tsx`).
  It owns a per-mount placement ledger (a `useRef` holding a `Set`).
- Every non-null part (`options`, `switcher`, `creators`) and `body` is wrapped in a
  DOM-less `<PlacedPart part="…">`. Its `useLayoutEffect` adds the part to the ledger and
  its cleanup removes it.
- Any change to the ledger queues one deduped `queueMicrotask(verify)`. React runs all of
  a commit's layout effects in one synchronous pass, portaled subtrees included, so the
  microtask sees the settled placement of that commit. This works whether the frame
  re-renders by itself or the host re-renders.
- `verify` fails when `body` is in the ledger and some built part is not. It stores
  `{ frame: Frame.displayName ?? Frame.name, missing }` in state. `HostedFrameHost` then
  **throws on the next render**, with a message naming the frame, the missing part and
  the rule. The DataView's error boundary catches it. This is loud and in every
  environment, per "fail loudly".
- Documented edge: a frame that **portals** a part must hold back `body` until its portal
  target is attached. Otherwise the first commit has rows without controls. The explorer
  does this (below), and the doc comment on `HostedToolbarParts` says so.

Contract and doc updates in `core/internal/toolbar-arrangement.ts`:
- `HostedToolbarParts`: replace "render it" with the enforced rule, and describe the
  portal edge.
- `HostedToolbarForms` gains `options: "revealed" | "visible"` (default `"revealed"`, so
  existing frames keep their behaviour). `"visible"` passes `revealOnHover={false}` to
  `CompactControls` through `HostedOptions`, for a frame that puts the trigger among
  always-visible toolbar buttons.

Existing frames to audit against the rule (each must pass or be fixed):
`sidebar-frame.tsx` and `running-agents-band.tsx` (conversations), `op-status-banner.tsx`,
`recent-runs.tsx` (background catalog), `backlinks.tsx` (page/links). From reading them,
only running-agents needs a closer look (it is collapsible). The others either render every
part, or receive only `null` for the parts they omit.

### 2. File explorer: the parts go into the toolbar via a dom-scope portal

The explorer's `Bar` lives in `FileBrowser`'s `Column` header. The DataView lives in the
scrolling body, and is only mounted once the root listing is `ok`. The parts are built
inside the DataView and need its controls context, which a React portal keeps. So the
frame portals them into a slot in the Bar:

- `browser/web/internal/controls-slot.ts`: `ExplorerControlsSlot = defineDomScope({ name:
  "file-explorer.view-controls", what: "the toolbar cell the folder view's controls portal
  into", bounds: [] })` (reusing `primitives/scope/dom-scope`).
- `file-browser.tsx`: wrap the browser in `ExplorerControlsSlot.Provider`. In the Bar,
  after the lens toggles, render a `rigid` inline cell with
  `ref={ExplorerControlsSlot.usePublishRef()}`. While no tree is mounted (loading or a
  listing problem), the cell is empty, which is correct: no rows, so nothing to control.
- `file-tree.tsx` `FileTreeFrame`: read `ExplorerControlsSlot.useRoot()`. While it is
  `{ attached: false }`, return `null`, holding the body back as the guard requires. In
  practice the Bar is attached before or in the same commit as the tree, so the
  synchronous re-render runs before paint. Once attached, render `body` plus
  `createPortal(<>{switcher}{creators}{options}</>, root)`.
  `HOSTED = { kind: "hosted", frame: FileTreeFrame, forms: { options: "visible" } }`.
  Update the frame's doc comment.
- The options popover still contains a search field bound to the same `query` as the
  explorer's Filter field. Both edit one state, so they cannot disagree. A second entry
  point is acceptable, and removing it is out of scope.

## Files

- `plugins/primitives/plugins/data-view/core/internal/toolbar-arrangement.ts`: contract docs, `forms.options`
- `plugins/primitives/plugins/data-view/web/components/toolbar/hosted-frame.tsx` (new): `HostedFrameHost`, `PlacedPart`, verify
- `plugins/primitives/plugins/data-view/web/components/data-view-body.tsx`, `components/data-view.tsx`: route both frame call sites through `HostedFrameHost`
- `plugins/primitives/plugins/data-view/web/components/toolbar/hosted-options.tsx`: `revealOnHover` from `forms.options`
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx`, `file-browser.tsx`, `internal/controls-slot.ts` (new)
- data-view `CLAUDE.md` (hosted toolbar prose); `docs/plugins-*` are regenerated by the build

## Verification

- `./equin test plugins/primitives/plugins/data-view`: extend `hosted-toolbar.test.tsx`:
  1. A frame rendering `body` but dropping `options` throws, and the message names the frame and `options`.
  2. With 2 views, dropping `switcher` throws; with 1 view (switcher `null`), dropping it passes.
  3. A frame hiding both body and options (collapsed) passes, and expanding it with body but no options throws.
  4. A frame portaling options into an attached node passes.
  5. `forms.options: "visible"` renders the trigger without the reveal class.
- `./equin test` for running-agents and the other hosted surfaces' suites.
- `./equin build`, then an e2e at `plugins/apps/plugins/file-explorer/plugins/browser/e2e/toolbar-controls.ts`:
  open `/files`, assert the options trigger is visible in the Bar (not inside the tree),
  click it, and assert the sort/filter/fields rows are there.
- `screenshot.ts --path /files` to check the toolbar row visually, light and dark.
- Open the other hosted surfaces (conversation sidebar, running-agents band, op-status
  banner, backlinks, Background → recent runs) and confirm none trips the guard.
