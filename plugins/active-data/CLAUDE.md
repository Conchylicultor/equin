# active-data

Meta plugin for inline interactive widgets rendered inside assistant text.
Sub-plugins under `plugins/active-data/plugins/<name>/` ship the component
that renders one widget kind.

Each `ActiveData.Tag` contribution declares a `display` mode:

- **`display: 'block'`** — agent wraps content in `<tag>…</tag>`. The host
  pre-extracts these before markdown parsing, so blank lines inside the tag
  body are handled correctly. Requires `tag: string`. The component receives
  `content` (trimmed inner text) and `attrs` (parsed tag attributes).
- **`display: 'code'`** — a token applied only inside backtick-wrapped inline
  code spans, never to regular text nodes. Two gates, and a claim protocol
  between them — see below.

**Inline chips are not an `ActiveData.Tag` mode.** A bare substring that renders
as a chip (`att-…`, `conv-…`, `<ui-context>`) is declared with
`InlineChip.Tag(inlineChip({…}))` from
`primitives/text-editor/plugins/inline-chip`, which owns the chip registry, the
one generic Lexical node, and `renderInlineChip` — read its `CLAUDE.md`. It is
backend-free so a composition without active-data can still draw a chip.
active-data's chip sub-plugins declare there — a chip for a declared id kind
(`task-`, `att-`, `conv-`, `proto-`, `block-`) through `id-chip`'s
`idChip`/`idChipServer`, its pattern derived from the kind — and active-data READS that
registry from its three host surfaces: the markdown enhancer and inline-text
walker (`useActiveDataLinkify`), and the page-editor bridge
(`internal/register-block-text-source.ts`, which registers the `"document"`
chips with `page/editor` — kept here so the page editor's host names no chip
family). The `active-data:document-chip-has-server-token` check also stays here:
it is written for these sub-plugins' server halves.

## `display:'code'` — the claim protocol

`pattern` is only the **syntactic** gate; several contributions legitimately
full-match one token (a short sha is also a valid plugin name). The **semantic**
gate is `useClaim`, sealed to its renderer by `codeTag()`:

```ts
ActiveData.Tag(codeTag({
  id: "plugin-link",
  pattern: PLUGIN_NAME_RE,
  useClaim: usePluginClaim,   // (text) => CodeClaim<PluginNode>
  component: PluginLinkChip,  // ({ content, value: PluginNode }) — pure renderer
}))
```

`CodeClaim<T>` (`web/claim.ts`): `claimPending()` / `declined(reason)` /
`claimed(value)`. `internal/code-chain.tsx` walks the syntactic candidates and
renders the first that claims — on `declined` it moves on, on `pending` it renders
the plain terminal `<code>` and **stops** (walking past a loading candidate would
fire the next one's I/O for an answer about to be discarded, then flicker).

Rules that look optional and aren't:

- **No contribution renders its own plain `<code>`.** A rendered fallback is
  indistinguishable from a success, so it starves every other candidate for the
  token. The host owns the fallback (`<InlineCode>`); `./singularity check
  active-data:no-adhoc-inline-code` enforces it.
- **The chain reads the registry itself, never a candidates prop** — the markdown
  renderer memoizes its whole element, so a prop freezes a boot-time snapshot in.
- **An inline chip has no claim protocol and must stay self-certifying.**
  Every inline pattern is unioned into ONE Lexical node, so a "declined" inline
  token would still be a committed node in the user's document with no host to
  catch it. A pattern whose validity needs I/O goes in `display:'code'`.

Hosts wire two helpers:

- `useActiveDataSegments(rawText)` — splits the raw string into `markdown`
  segments (passed to `<ReactMarkdown>`) and `block` segments (rendered
  directly as the contributed component, outside the markdown pipeline).
- `useActiveDataLinkify()` — returns a function that walks a rendered
  ReactNode tree and splices in the `"transcript"` inline chips. Call it from
  inside the host's react-markdown `transform` helper. Skips `code`/`pre`/`a`
  and custom components.

Renderers needing the host conversation read it via
`conversationPane.useData()` directly; the slot does not pipe it.

## Persisting widget state — `useActiveDataBinding`

Block widgets often have follow-up state — a task was created, a conversation
was launched. Component-local `useState` resets on reload because the
assistant text re-renders fresh each mount. The binding primitive persists
per-widget payload server-side, keyed by
`(conversationId, messageId, tag, occurrenceIndex)`.

The host renderer wraps each block segment in
`<ActiveDataIdentityProvider conversationId messageId tag occurrenceIndex>`
(JSONL `assistant-text-row` does this — `messageId` is Claude's per-event
uuid, `occurrenceIndex` is the count of prior block segments with the same
tag in the message). Inside the contributed component:

```ts
const TaskBindingSchema = z.object({ taskId: z.string() });
const binding = useActiveDataBinding(TaskBindingSchema);

// `binding.value` is a read: loading, error, or ready with the payload (or null).
if (binding.enabled) {
  if (binding.value.status === "loading") return null;  // avoid flashing the editable card
  if (binding.value.status === "error")
    return <ResourceErrorInline error={binding.value.error} refetch={binding.value.refetch} variant="inline" />;
}
const value = foldResource(binding.value, { loading: () => null, error: () => null, ready: (v) => v });
if (value?.taskId) return <TaskChip taskId={value.taskId} />;
// ... otherwise render the editable card; call binding.set({ taskId }) on action
```

Behavior:

- One live value per conversation — `activeDataBindings`
  (`liveValue("active-data.bindings", { params: ["conversationId"] })` in
  `core/resource.ts`, served by `serveValue(…, { source: "db", unbounded })` in
  `server/internal/resource.ts`) — so all widgets in a conversation share one
  subscription, each picking its own row by
  `(messageId, tag, occurrenceIndex)`. A value, not a collection: that
  composite is the table's key, so there is no single id to read a row by. The
  change feed pushes it on every write; the routes notify nothing.
- `set` upserts via `PUT /api/active-data/bindings/...`; `clear` deletes.
- When `messageId` is absent (legacy logs), `enabled` is `false` and `set` /
  `clear` no-op — the widget falls back to non-persistent React state.
- Cascades on conversation delete; no GC sweep needed.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Meta plugin for inline interactive widgets agents render via XML-like tags in assistant text. Sub-plugins contribute block (tag) and code (claimed code-span) renderers, and declare inline chips through primitives/text-editor/inline-chip; hosts use useActiveDataSegments() + useActiveDataLinkify(). Persistent state for inline interactive widgets — table + resource keyed by (conversationId, messageId, tag, occurrenceIndex).
- Web:
  - Slots: `ActiveData.Tag`
  - Slot contributors:
    - `ActiveData.Tag` ← `active-data.commit-link`
    - `ActiveData.Tag` ← `active-data.go`
    - `ActiveData.Tag` ← `active-data.plugin-link`
    - `ActiveData.Tag` ← `active-data.task`
  - Contributes:
    - `MarkdownEnhancerSlot`
    - `InlineTextWalkerSlot`
  - Uses: 21 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/markdown` ×5
    - `primitives/text-editor/inline-chip` ×5
    - `primitives/inline-text` ×4
    - `infra/endpoints` ×2
    - `page/editor` ×2
    - `primitives/live-state` ×2
    - `network/live.useLive`
  - Exports (types):
    - `ActiveDataBindingHandle`
    - `ActiveDataBlockContribution`
    - `ActiveDataCodeContribution`
    - `ActiveDataContribution`
    - `ActiveDataIdentity`
    - `ActiveDataSegment`
    - `CodeClaim`
    - `CodeResolver`
  - Exports (values):
    - `ActiveData`
    - `ActiveDataIdentityProvider`
    - `claimed`
    - `claimPending`
    - `codeTag`
    - `declined`
    - `maskCode`
    - `useActiveDataBinding`
    - `useActiveDataIdentity`
    - `useActiveDataLinkify`
    - `useActiveDataSegments`
- Server:
  - Contributes: `resource.declare` "active-data.bindings"
  - Uses:
    - `database.db`
    - `database/derived-updated-at.deriveUpdatedAt`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `network/live.serveValue`
    - `tasks/tasks-core._conversations`
  - DB schema: `plugins/active-data/server/internal/tables.ts`
  - Exports (values): `_activeDataBindings`
  - Resources: `active-data.bindings` (push, unbounded: one conversation's widget bindings — a handful per assistant message; the table's key is the composite (conversationId, messageId, tag, occurrenceIndex), so no single-id :rows read fits)
  - Routes:
    - `PUT /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex`
    - `DELETE /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `ActiveDataBinding`
    - `ActiveDataBindingsPayload`
    - `PutBindingBody`
  - Exports (values):
    - `activeDataBindings`
    - `ActiveDataBindingSchema`
    - `ActiveDataBindingsPayloadSchema`
    - `deleteBinding`
    - `putBinding`
    - `putBindingBodySchema`
- Cross-plugin:
  - Imported by:
    - `active-data/commit-link`
    - `active-data/go`
    - `active-data/plugin-link`
    - `active-data/task`
    - `conversations/conversation-view/jsonl-viewer/assistant-text`
- Sub-plugins:
  - **`attempt`** — Renders raw `att-<id>` strings inline as clickable chips named after the attempt's conversation, opening that conversation (the attempt pane when it has none), and presents the attempt id kind to…
  - **`build-run`** — Renders a bare `build-<id>` in a transcript as the generic id chip (`Build <short commit>`) that opens the build's run-detail pane, and presents the build-run id kind to the id registry. The…
  - **`commit-link`** — Renders commit shas in backtick-wrapped inline code as clickable chips that open the commit-detail pane, with the subject, author and date on hover. Resolves the sha against the main checkout's…
  - **`conv`** — Renders raw `conv-<id>` strings inline as clickable chips that open the referenced conversation in the right side pane alongside the host conversation, and presents the conversation id kind (title +…
  - **`event-source`** — Renders a bare `evs-<id>` in a transcript as the generic id chip (the source's name) that opens the event source's detail pane, and presents the event-source id kind to the id registry. The…
  - **`go`** — Renders <go>…</go> in an agent's reply — a part of the answer the user can pick as their reply — as one tinted unit, [text | ▶]: ▶ sends it back as <go>…</go> (the agent reads the part of its answer…
  - **`id-chip`** — Id chips, web half: idChip({ presenter, surfaces, component? }) mints a kind's IdKinds.Presenter together with its inline chip — the pattern derived from the kind (never re-typed), a generic title +…
  - **`page-link`** — Renders raw `block-<id>` strings inline as clickable chips that open what the id names: a page id opens the page-detail pane, a content-block id opens the block-detail pane (that block as a page of…
  - **`plugin-link`** [exempt] — Renders plugin IDs in backtick-wrapped inline code as clickable chips that open the plugin-view pane. Models emit the plugin's dotted id (e.g. `tasks`, `active-data.conv`) and the chip validates and…
  - **`prototype`** — Renders raw `proto-<id>` strings inline as clickable chips (the generic id chip: the mock's title) that open the mock in the prototype-detail pane, and presents the prototype id kind to the id…
  - **`report`** — Renders a bare `report-<id>` in a transcript as the generic id chip (the report's kind and message) that opens the report's detail pane, and presents the report id kind to the id registry. The…
  - **`song`** — Renders a bare `song-<id>` in a transcript or a page as the generic id chip (the song's title) that opens it in Sonata's player, and presents the song id kind to the id registry. The song id chip's…
  - **`task`** — Renders <task>prompt</task> tags as editable cards with Create + Launch actions. Models suggest tasks inline; users tweak and act without leaving the transcript.
  - **`task-link`** — Renders raw `task-<id>` strings inline as clickable chips that open the task detail pane, and presents the task id kind (title + open) to the id registry. Models emit the bare id, no tag wrapping…

<!-- AUTOGENERATED:END -->
