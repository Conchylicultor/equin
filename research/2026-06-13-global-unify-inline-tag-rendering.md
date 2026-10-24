# Unify inline-tag rendering across compose + read surfaces

## Context

The element-picker `<ui-context …>…</ui-context>` token renders as a **rich chip
while composing** (in the Lexical prompt editor / Improve popover) but prints as
**raw text once the message is sent** (in the conversation user-text view). The
user reported this and asked *why the surfaces aren't unified structurally*.

Root cause: there are **two independent registries** for "a token in text → a
widget", and `ui-context` is registered in only one of them:

| Registry | Feeds | `ui-context`? |
|---|---|---|
| `registerNodeExtension` (text-editor, module-level) | Lexical compose editor | ✅ bespoke `UiContextNode` |
| `ActiveData.Tag` (active-data) | read surfaces (markdown linkify) | ❌ |

The user-text **read** renderer consults *neither* registry — it pipes `e.text`
through `FileLinkText` (file-path links only) inside `whitespace-pre-wrap`, so the
literal tag prints.

**Goal (decided with the user):** make `ActiveData.Tag` the **single source of
truth** and **bridge it into the Lexical editor**, so that registering one inline
contribution lights a token up in **compose + assistant-read + user-read** with no
per-surface wiring. Future inline tags are then opt-in-by-default everywhere. The
bespoke `UiContextNode` is deleted; `ui-context` becomes a plain inline
contribution like `conv` / `task-link`.

**Out of scope (decided with the user): images.** Images already render on both
surfaces and their divergence is wrapped in genuinely separate concerns — async
upload on paste/drop (`ImageUploadPlugin`), a server-side
`![](/api/attachments/<id>)` → `@/disk/path` rewrite (`resolveAttachmentRefs`),
and server-side disk-read base64 segmentation (`pushTextWithImages`). By display
time an image is a typed `{kind:"image"}` segment, **not** a text token, so it does
not reduce to a shared text-token registry. We leave the image pipeline untouched.
The new registry is scoped to **inline text tokens that survive verbatim on both
sides** (`ui-context`, `conv`, `task-link`, `attempt`).

## Design

One registry (`ActiveData.Tag`, `display:"inline"`), three consumers:

1. **Assistant read** — already works via the active-data markdown enhancer
   (`useActiveDataLinkify`). No change.
2. **User-text read** — NEW: run `useActiveDataLinkify()` over the rendered text.
3. **Lexical compose editor** — NEW: a generic bridge mirrors every inline
   contribution into the editor as one generic `DecoratorNode`, replacing per-tag
   Lexical nodes.

### Part A — Editor bridge (the load-bearing piece)

Constraint: the editor reads node extensions from a module-level array
(`getNodeExtensions()`), but active-data inline contributions are only known at
React runtime (`ActiveData.Tag.useContributions()`). The `TextEditor` component
*is* a React component, so it can gather runtime extensions at mount — but
text-editor (a primitive) must **not** import active-data (wrong dependency
direction). Invert via a slot owned by text-editor.

**text-editor** — `plugins/primitives/plugins/text-editor/web/`
- Add a slot, e.g. `TextEditorSlots.NodeExtensions`, whose contribution is a hook
  `use: () => readonly NodeExtension[]` (reuse the existing `NodeExtension` type in
  `internal/node-extensions.ts`).
- In the `TextEditor` component, gather at mount:
  `const dynamic = TextEditorSlots.NodeExtensions.useContributions().flatMap(s => s.use())`
  then merge `[...getNodeExtensions(), ...dynamic]` and feed the merged list to
  both `initialConfig.nodes` (the node **classes**) and the markdown-sync plugin
  (patterns + `createNodeFromMatch`). Calling `s.use()` per contribution is safe
  under rules-of-hooks because the contribution set is fixed at plugin-load
  (stable order/length) — same pattern other slot consumers use.
- Keep `registerNodeExtension` (module registry) for static extensions
  (paste-images `ImageNode`). It is unchanged.

**active-data** — `plugins/active-data/web/`
- Add a generic `ActiveDataInlineNode extends DecoratorNode<ReactNode>` (mirror
  the deleted `ui-context-node.tsx`): stores the **raw matched substring**;
  `isInline()→true`; `getTextContent()`/`serializeNode` return the raw text (so
  copy-paste and markdown round-trip are exact); `decorate()` →
  `<ActiveDataInlineChip text={raw} />`.
- `ActiveDataInlineChip` reads `ActiveData.Tag.useContributions()`, finds the
  first `display:"inline"` contribution whose `pattern` matches `text`, and renders
  `<Component content={text} attrs={{}} />` (component unsealed via
  `UNSAFE_unsealSlotComponent`, as `linkify-active-data.tsx` already does).
  Provides native Lexical removal when the editor is editable.
- Contribute one `TextEditorSlots.NodeExtensions` source whose `use()` hook builds:
  - `node: ActiveDataInlineNode`
  - `deserializePattern`: the **union** of all inline patterns
    (`new RegExp(patterns.map(p => `(?:${p.source})`).join("|"), "g")` — per-pattern
    lookbehind/ahead stay intact inside each alternative)
  - `createNodeFromMatch: (m) => $createActiveDataInlineNode(m[0])`
  - `serializeNode: (n) => $isActiveDataInlineNode(n) ? n.getText() : null`

Net effect: every inline active-data token now renders as a removable chip in the
editor automatically.

### Part B — User-text read surface

`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/web/components/user-text-row.tsx`
- Call `const linkify = useActiveDataLinkify()` and wrap the rendered text:
  `linkify(<FileLinkText text={value} onFileOpen={onFileOpen} />)` in both the
  `SegmentedContent` text-segment branch and the plain fallback branch.
- `linkify` walks the node tree, skips the file-link buttons (custom components /
  `<a>`) and splices the inline chip into residual text — matching how the
  markdown path already composes file-links + active-data linkify.
- **Verify ordering:** confirm `FileLinkText`'s file-path regex doesn't mangle a
  substring *inside* the `<ui-context …>` token (its `url=`/`path=` values).
  Analysis says it won't (no `dir/file.ext` shape inside the token), but it's the
  one composition risk — check in the e2e run. If it does, pre-tokenize: run
  linkify on the raw string first, then file-links over the gaps.

### Part C — element-picker becomes a contributor

`plugins/improve/plugins/element-picker/`
- **Add** an inline contribution to `ActiveData.Tag`:
  `{ display:"inline", pattern: UI_CONTEXT_RE, component: UiContextChipRenderer }`
  where `UiContextChipRenderer({content}) = { const m = parseUiContext(content); return m ? <UiContextChip meta={m}/> : <>{content}</> }`.
  (`UI_CONTEXT_RE` / `parseUiContext` are already exported from the core barrel;
  `UiContextChip` stays internal, wrapped by the renderer.) This means
  element-picker now imports `@plugins/active-data/web`.
- **Delete** `web/internal/register-node.ts` and `web/internal/ui-context-node.tsx`,
  and the `import "./internal/register-node"` line in `web/index.ts`.
- Drop the now-unused `@plugins/primitives/plugins/text-editor/web` import if
  nothing else there needs it. Keep `internal/marker-middleware` (DOM lineage,
  unrelated).
- Copy-on-copy of the chip (previously `UiContextNode.getTextContent`) is now
  covered generically by `ActiveDataInlineNode.getTextContent` → raw tag.

### Part D — Docs

Update the three plugin `CLAUDE.md` blocks (element-picker: now an active-data
inline contribution + generic editor bridge, no bespoke node; active-data: inline
contributions also render in the editor via the bridge; text-editor: new
`NodeExtensions` slot), then run `./equin build` so the autogen reference
blocks and `docs/plugins-*.md` regenerate (the `plugins-doc-in-sync` check gates
this).

## Critical files

- `plugins/primitives/plugins/text-editor/web/internal/node-extensions.ts` — `NodeExtension` type, module registry (kept)
- `plugins/primitives/plugins/text-editor/web/` (editor component + `index.ts`) — add `NodeExtensions` slot, gather dynamic extensions
- `plugins/active-data/web/slots.ts` + `web/index.ts` + new `web/internal/active-data-inline-node.tsx` — generic node + bridge contribution
- `plugins/active-data/web/internal/linkify-active-data.tsx` — reference for unseal + component lookup (reuse pattern)
- `plugins/improve/plugins/element-picker/web/index.ts` + `core/index.ts` (`UI_CONTEXT_RE`, `parseUiContext`) + `web/components/ui-context-chip.tsx` — add contribution, delete bespoke node
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/web/components/user-text-row.tsx` — linkify the read view

## Key decisions & caveats

- **Behavior expansion (intended):** `conv` / `task-link` / `attempt` tokens will
  now also render as chips **inside the compose editor** (today they're plain text
  while typing). This is the natural consequence of true unification and round-trips
  to identical text on submit. If any token should stay plain in the editor, add an
  optional per-contribution opt-out flag (e.g. `editorChip?: boolean`, default on) —
  not needed for the reported bug; confirm during review.
- **Explicit remove "×":** the old `UiContextNode` showed an inline × button via
  `onRemove`. The generic chip relies on Lexical's native atomic-decorator deletion
  (backspace). If we want to keep the ×, wrap editor-rendered inline chips in a
  generic removal chrome in `ActiveDataInlineChip` rather than per-component.
- **Boundary direction stays a DAG:** active-data → text-editor (primitive) and
  element-picker → active-data are both fine; no cycle (active-data does not depend
  on element-picker).
- **Images untouched** — verify no regression, do not migrate.

## Verification

1. `./equin build` (also runs checks: `type-check`, `plugin-boundaries`,
   `plugins-doc-in-sync`).
2. End-to-end with `e2e/screenshot.mjs` against `http://<worktree>.localhost:9000`:
   - Pick a UI element → confirm the chip still renders in the Improve popover
     (now via the generic bridge, not the deleted node).
   - Submit the message → open the conversation → **confirm the `ui-context` chip
     renders in the user message** (the reported bug, now fixed) instead of raw text.
3. Regression checks:
   - Assistant text still renders `conv-…` / `task-…` chips (no change).
   - Paste an image in the editor → thumbnail; submit → inline image renders on
     display (image pipeline unaffected).
   - Copy a chip from the editor and paste elsewhere → the full `<ui-context …>` tag
     round-trips (generic `getTextContent`).
4. `./equin check` clean.
