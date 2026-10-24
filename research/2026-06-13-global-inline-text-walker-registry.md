# Inline-text walker registry — eliminate the order-dependent silent-failure footgun

## Context

Read surfaces that render inline interactive widgets inside **plain text** (file paths,
`<ui-context>` chips, `conv-`/`att-`/`task-` references) must apply two independent
linkify walkers — **active-data** and **file-links** — and the composition only works in
one specific order. The wrong order type-checks, runs, and **silently renders raw text**.
This already caused a real bug (commit `970feef8a`: `<ui-context>` tags rendered as chips
while composing but printed as raw text in sent user messages).

### Why the order is forced (not arbitrary)

Both walkers are `(ReactNode) => ReactNode`, both leave **custom React components opaque**
(`if (typeof el.type !== "string") return el;`) and recurse transparently through `Fragment`.
But they are **not symmetric** when seeded with a raw string:

- `useActiveDataLinkify()(rawString)` → an array containing **raw text remnants** (Fragment-wrapped) → still composable by a second walker.
- `linkifyChildren(rawString, …)` → a single `<FileLinkText text={rawString}/>` **custom component** → opaque → any second walker no-ops on it.

So active-data **must** run first: `linkifyChildren(linkify(rawString), onFileOpen)`. The
wrong wiring `linkify(<FileLinkText text={s}/>)` is the footgun — nothing surfaces the
mistake (no type error, no runtime error).

### Why this is a structural leak

The **markdown** path already solves this correctly via an **ordered registry** — the
`MarkdownEnhancerSlot` (`active-data` `order:0`, `file-links` `order:10`); consumers just
write `<Markdown>{text}</Markdown>` and never name or order a walker. The footgun lives
**only in the plain-text path** (`user-text-row.tsx`), which hand-composes the two walkers
with no registry and no order enforcement. This is exactly the collection-consumer leak
CLAUDE.md warns against: consumers naming and ordering individual contributors by hand.

### Intended outcome

A unified, ordered **inline-text walker registry** mirroring the markdown enhancer slot.
Consumers call ONE generic API (`<InlineText text=… />`) that **always seeds with a raw
string** and composes walkers in registry order — making the wrong order **unrepresentable**.
Adding a future inline widget type = one registration, zero consumer changes.

## Design

### New primitive: `plugins/primitives/plugins/inline-text/`

A pure library + slot host (like `file-links`); **zero** dependency on `active-data` or
`file-links` (they depend on it — keeps the DAG correct, exactly like `markdown`). Directly
mirrors the markdown pipeline (`markdown.tsx` + `enhancement-context.tsx`), minus the
markdown-only `components`/`inlineCode` stages.

**`web/internal/slot.ts`** — clone of `MarkdownEnhancerSlot`:

```ts
export const InlineTextWalkerSlot: Slot<{
  id: string;
  order: number;                                    // lower = runs first
  Component: ComponentType<{ children: ReactNode }>;
}> = defineSlot("inline-text.walker");
```

**`web/internal/walker-context.tsx`** — clone of `enhancement-context.tsx`, transform-only:

```ts
export interface InlineTextWalker { transform: (children: ReactNode) => ReactNode; }
const ctx = createContext<{ transforms: Array<(c: ReactNode) => ReactNode> }>({ transforms: [] });
export const InlineTextWalkerContext = ctx;
export function useInlineTextWalker(addition: InlineTextWalker | null): { transforms: [...] };
// appends addition.transform to parent.transforms (memoized), like useMarkdownEnhancement
```

**`web/internal/inline-text.tsx`** — the generic consumer API; seed is the **raw string**:

```ts
export function InlineText({ text, className }: { text: string; className?: string }): ReactNode {
  const walkers = InlineTextWalkerSlot.useContributions();
  const sorted = useMemo(() => [...walkers].sort((a, b) => a.order - b.order), [walkers]);
  let content: ReactNode = <InlineTextSeed text={text} />;
  for (let i = sorted.length - 1; i >= 0; i--) content = <sorted[i]!.Component>{content}</sorted[i]!.Component>;
  return className ? <span className={className}>{content}</span> : <>{content}</>;
}

function InlineTextSeed({ text }: { text: string }) {
  const { transforms } = useContext(InlineTextWalkerContext);
  return <>{transforms.reduce((acc, fn) => fn(acc), text as ReactNode)}</>;
}
```

The seed is a `string`, so a custom-component root is **structurally impossible** — the whole
point. Walkers are **nested as Components** (not called in a `.map` loop), so each may freely
call its own hooks (rules-of-hooks safe). This is the proven `<Markdown>` pattern.

**`web/index.ts`** exports: `InlineText`, `InlineTextWalkerSlot`, `InlineTextWalkerContext`,
`useInlineTextWalker`, type `InlineTextWalker`. No own `default` contributions.
Add `package.json` + `CLAUDE.md` stub.

### Route decision: **separate slot, walkers register in both** (Route 2)

`active-data` and `file-links` each register a walker into `InlineTextWalkerSlot` **in
addition to** their existing `MarkdownEnhancerSlot` registration, sharing the same closure.

**Rejected — Route 1 (make `<Markdown>` consume the inline-text slot):** markdown carries
three things per enhancer (`transform`, `components` a/img overrides, `inlineCode` handlers —
see `enhancement-context.tsx:4-8`); only `transform` is the shared walker. Re-plumbing
`<Markdown>`'s transform stage onto a different slot while keeping its markdown-only stages
means two registries + two `order` axes feeding one renderer that 8+ plugins depend on. Bad
risk/reward against an already-correct, tested path. Route 2 satisfies collection-consumer
separation (consumers call only `<InlineText>`) at the cost of one extra ~10-line wrapper per
walker, sharing the same closure so behavior can't drift. The deeper unification is recorded
as a **follow-up** below, not bundled into this fix.

### Walker registrations & where they live (boundary-safe)

- **active-data walker → in `active-data`** (`plugins/active-data/web/`). Needs no host
  config — just `useActiveDataLinkify()`. New `web/internal/inline-walker.tsx` Component
  pushing `(c) => linkify(c)` via `useInlineTextWalker`; register
  `InlineTextWalkerSlot({ id: "active-data", order: 0, Component: ActiveDataInlineWalker })`
  in `active-data/web/index.ts`. active-data now also depends on `inline-text` (primitive→primitive, clean).

- **file-links walker → in `markdown-extensions`** (`plugins/conversations/plugins/conversation-view/plugins/markdown-extensions/web/`),
  **not** in the `file-links` primitive — the `onFileOpen` resolution needs
  `conversationPane`/`taskDetailPane`/`useConversationById`, which the generic primitive must
  not import (boundary rule). This mirrors the existing split (primitive = pure
  `linkifyChildren`; `markdown-extensions` = conversation-scoped wiring). New
  `web/internal/file-links-inline-walker.tsx` reusing the **same** `onFileOpen` resolution as
  `FileLinksEnhancer`, pushing `(c) => linkifyChildren(c, onFileOpen)` via `useInlineTextWalker`;
  register `InlineTextWalkerSlot({ id: "file-links", order: 10, Component: FileLinksInlineWalker })`
  in `markdown-extensions/web/index.ts`.
  - **Refactor to prevent divergence:** extract the worktree→`onFileOpen` resolution
    (currently duplicated in `file-links-enhancer.tsx:18-34` and `code-enhancer.tsx:16-29`)
    into a shared `web/internal/use-file-open.ts` hook; have `FileLinksEnhancer`, `CodeEnhancer`,
    and the new inline walker all consume it. Keeps markdown and plain-text file-open identical
    by construction. The same hook already handles `conversation?.attemptId ?? (taskEntry ? "main" : peekWorktree)`,
    so it covers **both** the user-text (conversation) and task-description (task) surfaces.

`markdown-extensions` already imports `file-links`, `markdown`, `conversations`, `tasks`; it
now also imports `inline-text`. No primitive gains a feature-plugin dependency.

### Migrations

**`…/jsonl-viewer/plugins/user-text/web/components/user-text-row.tsx`** (the buggy consumer):
- Drop imports of `useActiveDataLinkify`, `linkifyChildren`, and the file-pane wiring
  (`useOpenPane`, `filePeekPane`, the `onFileOpen` closure, `linkify` hook, and the `linkify`
  prop threaded into `SegmentedContent`).
- Text branch (lines 67-69) → `<InlineText text={seg.value} />`.
- Non-segmented branch (lines 111-113) → `<InlineText text={e.text} />`.
- Net: the row stops naming either walker and drops its direct file-pane dependency; file-open
  now resolves inside the file-links walker via the shared `useFileOpen()` (same as markdown).
  Keep `whitespace-pre-wrap break-words` by passing `className` to `<InlineText>` (or wrap in the existing `<Text>`).

**`plugins/tasks/plugins/task-description/web/components/description-view.tsx`** — **migrate**:
- Text segments currently render via `<FileLinkText text=… onFileOpen=…>` alone (file-links but
  no active-data → `conv-`/`task-`/`<ui-context>` chips do **not** appear in task descriptions).
  Switch text segments to `<InlineText text={seg.value} />` so active-data chips light up too —
  the payoff of the abstraction ("new surface = use the generic API"). The file-links walker's
  `useFileOpen()` resolves the worktree from `taskDetailPane` (→ `"main"`), so file links keep working.
- **Caveat to verify during impl:** confirm `DescriptionView` renders within the pane-router
  context where `taskDetailPane.useRouteEntry()` resolves. If the existing `onFileOpen` prop
  has semantics the walker's context can't reproduce, fall back to migrating only the inner
  text rendering / defer this surface to a fast-follow. Lean migrate-now.

**`…/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx`** — **no change**:
- Uses `useActiveDataSegments()` to split off **block** tags (rendered directly), then renders
  the remaining markdown/text segments through `<Markdown>`, which already runs both inline
  walkers via the enhancer slot. Block segments are pre-extracted from the text before inline
  walking, so blocks and inline walkers don't interact. Out of scope.

### Regression guard (kill the "silent" half)

- `<InlineText>` makes the correct path the **only** path for consumers — primary guard.
- Keep `linkifyChildren`, `FileLinkText`, `useActiveDataLinkify` exported (still needed by the
  markdown enhancers and the new walkers).
- **Add a dev-only loud failure** at the entry of each walker (`walk` in `linkify-active-data.tsx`
  and `linkifyChildren` in `linkify-children.tsx`): if the **root** arg `isValidElement(node)`
  and `typeof node.type !== "string"` and it's not a `Fragment` (the exact wrong-order
  signature — a walker seeded with a custom-component root), `console.error` in dev. ~3 lines,
  no new files, converts the silent no-op into a loud, debuggable failure for any future
  hand-composition. (A lint rule can't express "string-rooted vs component-rooted `ReactNode`",
  so the runtime dev-guard is the lower-cost, higher-coverage option.)

## Files

**Create**
- `plugins/primitives/plugins/inline-text/web/internal/slot.ts`
- `plugins/primitives/plugins/inline-text/web/internal/walker-context.tsx`
- `plugins/primitives/plugins/inline-text/web/internal/inline-text.tsx`
- `plugins/primitives/plugins/inline-text/web/index.ts`
- `plugins/primitives/plugins/inline-text/package.json`, `CLAUDE.md`
- `plugins/active-data/web/internal/inline-walker.tsx`
- `…/markdown-extensions/web/internal/file-links-inline-walker.tsx`
- `…/markdown-extensions/web/internal/use-file-open.ts`
- `plugins/primitives/plugins/inline-text/web/__tests__/inline-text.test.tsx`

**Modify**
- `plugins/active-data/web/index.ts` (register active-data walker)
- `…/markdown-extensions/web/index.ts` (register file-links walker)
- `…/markdown-extensions/web/internal/file-links-enhancer.tsx`, `code-enhancer.tsx` (use shared `useFileOpen()`)
- `…/jsonl-viewer/plugins/user-text/web/components/user-text-row.tsx` (→ `<InlineText>`)
- `plugins/tasks/plugins/task-description/web/components/description-view.tsx` (→ `<InlineText>`)
- `plugins/active-data/web/internal/linkify-active-data.tsx`, `plugins/primitives/plugins/file-links/web/internal/linkify-children.tsx` (dev-only root guard)

## Implementation order

1. Create the `inline-text` primitive (slot, context, component, barrel, package.json, CLAUDE.md).
2. Add the active-data walker + register it.
3. Extract `useFileOpen()`; refactor `file-links-enhancer.tsx` + `code-enhancer.tsx` to use it.
4. Add the file-links inline walker + register it.
5. Migrate `user-text-row.tsx`; drop dead imports/wiring.
6. Migrate `description-view.tsx` text segments.
7. Add the dev-only root guard in both walkers.
8. Add the inline-text vitest; keep the element-picker `BrokenOrderView` test as documentation.
9. `./equin build`, run checks + dom tests, manual verify.

## Verification

- **vitest** at `plugins/primitives/plugins/inline-text/web/__tests__/inline-text.test.tsx`
  (auto-discovered; model on `plugins/improve/plugins/element-picker/web/__tests__/ui-context-read-render.test.tsx`):
  register a `ui-context` inline contribution + both walkers via a `PluginProvider`, render
  `<InlineText text={`See ${uiContextTag} and research/foo.md`} />`, assert the output contains
  the chip text **and** `research/foo.md`, does **not** contain `"<ui-context"`, and has a
  `<button>` for both. The component only accepts `text: string`, documenting that a
  component-root seed is impossible.
- `./equin build` then `./equin check plugin-boundaries` and `./equin check type-check`
  — confirm no new cross-plugin edges/cycles (`inline-text` + `file-links` import no feature
  plugins) and barrels stay pure. Build regenerates `plugins-details.md` for the new plugin/edges
  (`plugins-doc-in-sync` would fail otherwise).
- `bun run test:dom plugins/primitives/plugins/inline-text` and the element-picker test.
- **Manual** (`e2e/screenshot.mjs` against `http://<worktree>.localhost:9000/c/<id>`): a user
  message containing both a `<ui-context>` tag (or `conv-…`) and a file path → chip + clickable
  file link; a task description with a `conv-…` id → chip now appears (validates the
  task-description migration).

## Follow-up (recorded, not in scope)

The deeper unification: make the inline-text walker registry the single source of truth and
have `<Markdown>`'s transform stage **consume** it (markdown keeps only its markdown-only
extras — `inlineCode` handlers, `a`/`img` overrides). One registration per walker, no Route-2
duplication. Deferred because it rewrites the load-bearing markdown renderer; file as a task
after this lands if the duplication proves bothersome.
