# Transcript re-render / code-block remount loop — fix plan

> Note: the message referenced `research/2026-06-20-conversations-transcript-rerender-loop.md`, which does not exist in this worktree or on `main`. This doc supersedes it; all evidence below was re-derived from the code and the live render-loop detector.

## Context

On an **idle** conversation (status `waiting`, nothing streaming) the conversation view re-renders continuously at ~5×/s, and every re-render **remounts** (DOM teardown + rebuild) the syntax-highlighted code blocks in the transcript. This is continuous wasted CPU/battery and was the engine behind transcript text-selection loss (a rebuilt `<pre>` drops the selection/focus, which then escapes the `ContentScope` so Ctrl+A selects the whole page).

The repo already has a render-loop detector (`plugins/reports/plugins/render-loop`) that **has already captured this loop** in production telemetry on `main`:

- `AssistantTextRow → highlighted-code.tsx:111` — `childlist-rebuild @ 5/s` (the transcript amplifier).
- `MarkdownView (file-pane) → highlighted-code.tsx:111` — `@ 7/s` (the **same** markdown amplifier in a second surface — the code-file preview).
- `VoiceInputButton → prompt-editor.tsx:99` — `@ 5/s`, **time-synchronized** with the `AssistantTextRow` fire (same start, same sustained window, ~70–370ms apart across multiple firings).

The synchronization is the key finding: the transcript and the prompt editor are both descendants of the **conversation-view pane**, so a **single shared ancestor re-renders ~5×/s** and **multiple independent amplifiers** each remount off it. The accurate model is:

```
ONE initiator (conversation-view pane re-renders ~5/s)
  → amplifier A: markdown code blocks remount   (transcript + file-pane)
  → amplifier B: prompt-editor FloatingAction remount (voice-input)
  → secondary amplifiers: unmemoized context providers fan the churn wider
```

Both the initiator and the amplifiers must be addressed. After the initiator fix the churn stops; the amplifier fixes make each surface structurally robust so a *future* re-render can never again cause DOM thrash (the report's explicit requirement that a silenced loop "must be tracked explicitly or it will go unnoticed").

The same root defect (below) also explains the unrelated `data-view.tree @ 3/s` loop on the task-detail pane (tasks/attempts rows carry `Date`s too), so the chosen initiator fix is deliberately the one that fixes the whole class in one place.

Scope decisions (confirmed with the user):
- **Fix the initiator AND all amplifiers** found.
- **Client fix now; the server-side ~5/s push is a follow-up task** (it needs runtime DB-change instrumentation to pin the exact writer).

---

## Root causes

### Initiator — `Date` objects defeat live-state structural sharing

`ConversationView` (`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:19`) reads `useConversationById(convId)` → `useConversation(id)` (`plugins/conversations/web/use-conversations.ts:53`), a `select`-based read of `conversationsResource`.

live-state's documented contract (`plugins/primitives/plugins/live-state/CLAUDE.md`, "Slice selectors") is that `select` re-renders **only when the selected slice changes**, because React Query runs `replaceEqualDeep` on the select output and a deeply-equal slice keeps its previous reference. That promise is **silently broken** by `Date`:

- `ConversationSchema` (`plugins/tasks/plugins/tasks-core/server/internal/schema.ts:75-92`) coerces 5 fields with `z.coerce.date()` → the selected conversation row contains `Date` instances.
- React Query's `replaceEqualDeep` only recurses into **plain** objects/arrays; `isPlainObject(new Date())` is `false`, so it returns the *new* value for any `Date`, which bubbles up and makes the **whole conversation object a new reference on every push**.
- So every `conversationsResource` push re-renders `ConversationView` (and every other `useConversationById` consumer: `ConversationTitle`, `StatusBadge`, `CommitsChip`, `ActiveRelateSync`, `PromptInput`), regardless of whether anything the UI shows actually changed.

The server pushes `conversationsLiveResource` (`plugins/tasks/plugins/tasks-core/server/internal/resources.ts:31`) in `mode: "push"` with `debounceMs: 250` — i.e. a sustained writer flushes at the ~4/s ceiling, matching the observed ~5/s. **Why** the server writes `_conversations` ~5/s on an idle conversation is the follow-up investigation; the client-side dedup failure is the part fixed here.

`Date`-in-payloads is **intentional** design (live-state CLAUDE.md: "types like `Date` … are coerced … so consumers can rely on them"), and ~15 web consumers read these `Date` fields. So the fix must **not** change the wire schema — it must make structural sharing `Date`-aware at the one chokepoint.

### Amplifier A — markdown mints fresh component identities

`react-markdown` remounts a tag's subtree **only when that tag's component-function identity changes**. `HighlightedCode` already makes re-renders idempotent (module-level html cache → stable `__html` string → `dangerouslySetInnerHTML` never re-commits; `highlighted-code.tsx:22-38, 94-117`). So code blocks remount *purely* because the `code` override identity changes.

In `plugins/primitives/plugins/markdown/web/internal/markdown.tsx:21-26`, the `components` map is rebuilt by `stripNodeProp({ ...base, ...overrides })` inside a `useMemo`. `buildBaseComponents` + `stripNodeProp` (`internal/base-components.tsx`) mint **fresh closures for every tag** on each recompute, so any context-derived dep change re-mints `code` → full remount of every code block.

### Amplifier B — prompt-editor FloatingAction inline render-prop

`ToolbarRow` (`plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx:~96`) passes an **inline arrow** as the `children` render-prop to `PromptEditorSlots.FloatingAction.Render`. A new function each render busts `renderItem`'s `useCallback` in slot-render (`render-slot.tsx:159-184`, dep `[cleanById, children, horizontal]`) → busts the `entries` `useMemo` in the reorder middleware (`dnd-list-middleware.tsx:~594`, dep `renderItem`) → new `entry.node` trees + new `sortableIds` → dnd-kit `SortableContext` churn → the FloatingAction child (VoiceInputButton) rebuilds in the DOM.

### Secondary amplifiers — unmemoized context provider values

- `PromptInsertProvider` (`plugins/conversations/plugins/conversation-view/web/prompt-insert-context.tsx:26`) — `value={{ registerInsert, insertAtCursor }}` is a fresh object each render (the functions inside are stable `useCallback`s), re-rendering every `usePromptInsert()` consumer.
- `RowMarkdownProvider` (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/row-markdown-context.tsx:11`) — `value={{ markdownMode, setMarkdownMode }}` is a fresh object each render, re-rendering every `useRowMarkdown()` consumer (one per event row).

---

## Plan

### 1. Initiator: make live-state structural sharing `Date`-aware (fix-the-class)

Single change at the chokepoint `useResource` (`plugins/primitives/plugins/live-state/web/use-resource.ts:220-235`): pass a custom `structuralSharing` function to `useQuery`. React Query applies it to both the query-data merge and the `select`-result memoization, so a push whose content is deeply equal **including `Date` millis** keeps its previous reference → with the existing `select` + `notifyOnChangeProps: ["data","error"]`, the observer is not notified → no re-render.

- Add a small helper, e.g. `plugins/primitives/plugins/live-state/web/internal/structural-sharing.ts`, exporting `dateAwareReplaceEqualDeep(prev, next)` — a faithful copy of React Query's `replaceEqualDeep` algorithm with one added branch: `if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? a : b`. (Everything else — plain objects, arrays, primitives — unchanged.) Keep it dependency-free; do not import RQ internals.
- Wire it in `useResource`: `structuralSharing: dateAwareReplaceEqualDeep` on the `useQuery` options (applies to every resource, with and without `select`).
- This is strictly **stronger** dedup (only ever preserves a reference when deeply equal), never weaker — safe for all resources. It honors the documented `Date` contract and fixes the same defect for `tasks`/`attempts`/`pushes` (the `data-view.tree @ 3/s` loop) at the same time, with **zero consumer changes**.

Files:
- `plugins/primitives/plugins/live-state/web/internal/structural-sharing.ts` (new)
- `plugins/primitives/plugins/live-state/web/use-resource.ts` (wire option)

Caveat to verify at runtime: if the conversation row's timestamps genuinely tick on every push (a real `updatedAt` bump per write), the slice still changes and re-renders persist — that is precisely what the server-side follow-up addresses. Expectation (consistent with the loops existing only because of `Date`, not because primitive content changes): the ~5/s pushes are no-op recomputes with identical content, so `Date`-aware sharing eliminates the re-renders.

### 2. Amplifier A: stable markdown component identities

Rework `MarkdownRenderer` (`plugins/primitives/plugins/markdown/web/internal/markdown.tsx`) so per-tag component identities never change across renders:

- Keep the live `{ transforms, components: overrides, inlineCodeHandlers }` from context in a `ref` updated each render.
- Build the **base** map once: `useMemo(() => stripNodeProp(buildBaseComponents(transformViaRef, inlineHandlersViaRef)), [])`, where `transformViaRef`/`inlineHandlersViaRef` are stable closures reading `ref.current`. Result: `code` (and all base tags) have **permanent** identity → react-markdown never remounts them.
- Strip + memoize **overrides** separately: `const strippedOverrides = useMemo(() => stripNodeProp(overrides), [overrides])`.
- Merge: `useMemo(() => ({ ...base, ...strippedOverrides }), [base, strippedOverrides])`. `code` lives in `base` only, so its identity is constant forever; override tags (`a`, `img`) re-wrap only when overrides actually change.

Adjust `buildBaseComponents` (`internal/base-components.tsx`) to take the transform and inline-code handlers via stable accessors (read `ref.current` at call time) instead of capturing arrays at build time. This makes a recompute/re-render a cheap in-place re-render (HighlightedCode bails on stable html) — fixing **both** the transcript and the file-pane MarkdownView surfaces.

Files:
- `plugins/primitives/plugins/markdown/web/internal/markdown.tsx`
- `plugins/primitives/plugins/markdown/web/internal/base-components.tsx`

### 3. Amplifier B: stabilize the prompt-editor render-prop

In `ToolbarRow` (`plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx`), wrap the `FloatingAction.Render` children render-prop in `useCallback` keyed on its real deps (`editable`, `insertText`, `getContent`, `clearContent` — the latter three already `useCallback`-stable). A stable render-prop keeps `renderItem` / `entries` / `sortableIds` stable through slot-render + reorder, so a parent re-render becomes an in-place re-render of VoiceInputButton, not a remount.

File:
- `plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx`

### 4. Secondary amplifiers: memoize provider values

- `prompt-insert-context.tsx:26` — `useMemo(() => ({ registerInsert, insertAtCursor }), [registerInsert, insertAtCursor])`.
- `row-markdown-context.tsx:11` — `useMemo(() => ({ markdownMode, setMarkdownMode }), [markdownMode])`.

Files:
- `plugins/conversations/plugins/conversation-view/web/prompt-insert-context.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/row-markdown-context.tsx`

### 5. Follow-up (separate task, not in this change)

`add_task`: "Conversation view: eliminate the sustained ~4–5/s `conversationsLiveResource` push on idle conversations." It needs runtime instrumentation (the `live-state` log channel + DB change-feed logging / `query_db` sampling of `_conversations.updated_at`) to identify the writer (suspect: the conversation poller `plugins/conversations/server/internal/poller.ts` and/or a cascade recompute), then remove the spurious write per the no-polling / fail-loud rules. Even with the client fix, an unchanging-content push still wastes a server recompute + WS frame.

---

## Verification

1. `./equin build` from this worktree; open `http://<worktree>.localhost:9000` on a conversation that is **idle** (`waiting`) and contains fenced code blocks.
2. **DOM thrash gone** — confirm code blocks no longer remount while idle. The existing render-loop detector is the oracle: after the fix, the `render-loop` clientLog channel (`~/.singularity/worktrees/<wt>/logs/render-loop.jsonl`) should stop emitting `fire`/`near-miss` lines for the `AssistantTextRow … highlighted-code.tsx:111`, `MarkdownView … highlighted-code.tsx:111`, and `VoiceInputButton … prompt-editor.tsx:99` signatures. Cross-check the `reports` table (`SELECT … FROM reports WHERE kind='render-loop'`) shows no new rows for these signatures.
3. **Re-render rate dropped** — verify the conversation-view subtree no longer re-renders ~5×/s while idle (React DevTools Profiler "record while idle", or a temporary `useEffect(() => console.count("ConversationView render"))`). Expect near-zero renders/s when idle. Remove any temporary instrumentation before finishing.
4. **No regressions** — code blocks still highlight; text selection inside a code block survives an idle period (the original symptom); markdown links/images, active-data chips, file-links, and voice-input button all still work; switching `markdownMode` and conversations still works.
5. **Class-wide check** — confirm the `data-view.tree @ 3/s` task-detail loop is also gone (same `Date`-aware structural-sharing fix), via the same render-loop log/report check on the task-detail pane.
6. `./equin check` passes (type-check, boundaries, lint).

## Critical files

- `plugins/primitives/plugins/live-state/web/use-resource.ts` + new `internal/structural-sharing.ts` — initiator fix.
- `plugins/primitives/plugins/markdown/web/internal/markdown.tsx`, `internal/base-components.tsx` — amplifier A.
- `plugins/primitives/plugins/prompt-editor/web/components/prompt-editor.tsx` — amplifier B.
- `plugins/conversations/plugins/conversation-view/web/prompt-insert-context.tsx`, `…/jsonl-viewer/web/components/row-markdown-context.tsx` — secondary amplifiers.
- Reference (do not change): `plugins/primitives/plugins/syntax-highlight/web/internal/highlighted-code.tsx` (html cache / bail), `plugins/reports/plugins/render-loop/*` (verification oracle), `plugins/tasks/plugins/tasks-core/server/internal/{schema.ts,resources.ts}` (Date source / push config).
