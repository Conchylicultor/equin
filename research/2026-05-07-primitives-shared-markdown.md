# Shared Markdown Primitive

## Context

Three surfaces render markdown independently with their own component override maps (~15 elements each, 90% identical). Extracting a `<Markdown>` primitive with slot-based enhancers lets every consumer write `<Markdown>{text}</Markdown>` — no props, no wiring. Enhancers auto-activate based on pane context.

| Surface | File | Highlight | File links | Active data | Img proxy |
|---|---|---|---|---|---|
| Conversation transcript | `.../assistant-text/.../assistant-text-row.tsx` | Yes | Yes | Yes | Yes |
| File-pane markdown preview | `.../file-pane/plugins/markdown/.../markdown-view.tsx` | **No** | Yes | No | No |
| Debug memory viewer | `plugins/debug/plugins/memory/.../memory-panel.tsx` | **No** | No | No | No |

## Design

### Prerequisite: `useDataMaybe()` on pane primitive

Add a non-throwing variant of `useData()` to `PaneObject`. 3-line addition to `plugins/primitives/plugins/pane/web/pane.ts`:

```ts
function useDataMaybe(): Provides | null {
  const value = useContext(dataContext);
  return value === DATA_NOT_PROVIDED ? null : (value as Provides);
}
```

Expose on `PaneObject` interface alongside `useData()`. Miller columns compose ancestor `provide` components at the chain level, so `conversationPane.useDataMaybe()` returns data inside any descendant pane (e.g. filePeekPane) and `null` outside.

### `<Markdown>` component

Consumer-facing API: **no props** (except `children` and optional `className`).

```tsx
<Markdown>{text}</Markdown>
```

Internally:
1. Reads `Markdown.Enhancer` slot contributions
2. Wraps `<MarkdownRenderer>` in each enhancer component (outermost-first)
3. Each enhancer stacks transforms/overrides into an internal `MarkdownEnhancementContext`
4. `<MarkdownRenderer>` reads the accumulated context and builds the final `Components` map

### `Markdown.Enhancer` slot

Contributions are React wrapper components. Each wraps its children and contributes transforms/component-overrides by calling `useMarkdownEnhancement()` (exported by the primitive for enhancer authors):

```tsx
// Example enhancer component
function MyEnhancer({ children }: { children: ReactNode }) {
  const conv = conversationPane.useDataMaybe(); // null outside conversation
  const enhancement = useMemo(() => {
    if (!conv) return null;
    return { transform: ..., components: { img: ... } };
  }, [conv]);

  const value = useMarkdownEnhancement(enhancement);
  return (
    <MarkdownEnhancementContext.Provider value={value}>
      {children}
    </MarkdownEnhancementContext.Provider>
  );
}

// Registered as a slot contribution in the plugin's contributions[]
Markdown.Enhancer({ id: "my-enhancer", order: 10, Component: MyEnhancer })
```

Enhancers compose: transforms pipeline in order, component overrides merge (later wins).

### Base component map (built into `<MarkdownRenderer>`)

| Override | Behaviour |
|---|---|
| h1–h4 | Standard heading sizes + `font-semibold`; apply composed `transform` |
| p | `my-2`; apply `transform` |
| a | `text-primary underline`; external → `target="_blank"` |
| ul / ol | Disc / decimal + `pl-6 my-2` |
| li | `my-0.5`; apply `transform` |
| blockquote | Left-border muted; apply `transform` |
| hr | `my-4 border-border` |
| code | Block → `<HighlightedCode>`; inline → muted `<code>` pill |
| pre | `<>{children}</>` (HighlightedCode owns its own `<pre>`) |
| table / th / td | Border-collapse; `transform` on th/td |

### Exported API (barrel)

| Export | Purpose |
|---|---|
| `Markdown` | The component |
| `Markdown.Enhancer` | Slot for enhancer contributions |
| `useMarkdownEnhancement` | Hook for enhancer components to stack results |
| `MarkdownEnhancementContext` | Context (enhancers wrap children in its Provider) |
| `langFromClassName` | Extract language from `className` (for custom code overrides) |
| `nodeToText` | Extract text from ReactNode tree (for custom code overrides) |

## Enhancers

### 1. Active-data transform

**Plugin**: `plugins/active-data/` (contributes `Markdown.Enhancer`)
**Scope**: Global — `useActiveDataLinkify()` reads from the static slot system, returns identity when no contributions exist.

```tsx
// Contributes: { transform: useActiveDataLinkify() }
```

### 2. File-links transform + `a` override

**Plugin**: new `plugins/conversations/plugins/conversation-view/plugins/markdown-extensions/`
**Scope**: Conversation-scoped — uses `conversationPane.useDataMaybe()` for worktree, no-ops when null.

```tsx
// Gets worktree from conversation pane data (composed at chain level by Miller)
const conv = conversationPane.useDataMaybe();
const worktree = conv?.conversation.attemptId;

// Also checks taskDetailPane for task context (worktree = "main")
const task = taskDetailPane.useDataMaybe();
const wt = worktree ?? (task ? "main" : undefined);

const onFileOpen = wt
  ? (path, line) => filePeekPane.open({ worktree: wt, filePath: ... })
  : undefined;

// Contributes:
// - transform: (c) => linkifyChildren(c, onFileOpen) when available
// - components.a: file-path link detection when worktree available
```

### 3. Inline code enhancements

**Plugin**: same `markdown-extensions` plugin
**Scope**: Conversation-scoped — active-data inline code, URL detection, file-path buttons.

Overrides the base `code` component. Block code delegates to `<HighlightedCode>` (same as base). Inline code adds:
1. Active-data pattern detection (drop `<code>` wrapper, render chip)
2. URL detection (render as `<a>`)
3. File-path detection (render as clickable button)
4. Fallback: plain `<code>`

Uses `langFromClassName`/`nodeToText` from the markdown primitive.

### 4. Image proxy

**Plugin**: same `markdown-extensions` plugin
**Scope**: Conversation-scoped — proxies local images via `/api/code/<worktree>/image?path=...`.

1. External image → `<img src={src}>` directly
2. Local image + worktree available → `<img src={proxyUrl}>`
3. Local image + no worktree → `<img src={src}>` (fallback, will 404)
4. Non-image local path → handled by file-links (not the img override)

## Plugin structure

### New: `plugins/primitives/plugins/markdown/`

```
web/
  index.ts                    # barrel
  internal/
    markdown.tsx              # Markdown component + MarkdownRenderer
    enhancement-context.tsx   # MarkdownEnhancementContext + useMarkdownEnhancement
    helpers.ts                # langFromClassName, nodeToText
    base-components.tsx       # buildBaseComponents(transform)
package.json
CLAUDE.md
```

### New: `plugins/conversations/plugins/conversation-view/plugins/markdown-extensions/`

```
web/
  index.ts                    # barrel — contributes Markdown.Enhancer x3
  internal/
    file-links-enhancer.tsx   # transform + a override
    code-enhancer.tsx         # inline code enhancements
    img-enhancer.tsx          # image proxying
package.json
CLAUDE.md
```

### Modified: `plugins/active-data/web/index.ts`

Add `Markdown.Enhancer` contribution for active-data transform.

### Modified: `plugins/primitives/plugins/pane/web/pane.ts`

Add `useDataMaybe()` to `PaneObject`.

## Consumer migrations

### `memory-panel.tsx`

**Remove**: `react-markdown`/`remarkGfm` imports, `REMARK_PLUGINS`, `MD_COMPONENTS` (~28 lines)
**Add**: `import { Markdown } from "@plugins/primitives/plugins/markdown/web"`
**Replace**: `<ReactMarkdown ...>{content}</ReactMarkdown>` → `<Markdown>{content}</Markdown>`

### `markdown-view.tsx`

**Remove**: `react-markdown`/`remarkGfm` imports, `REMARK_PLUGINS`, `buildComponents`, `onFileOpen`, `linkifyChildren` import (~100 lines)
**Add**: `import { Markdown } from "@plugins/primitives/plugins/markdown/web"`
**Replace**: `<ReactMarkdown ...>{state.content}</ReactMarkdown>` → `<Markdown>{state.content}</Markdown>`

File-links now auto-activate via the enhancer (worktree available from `conversationPane.useDataMaybe()` since filePeekPane is a descendant in the chain).

### `assistant-text-row.tsx`

**Remove**: `react-markdown`/`remarkGfm` imports, `REMARK_PLUGINS`, `nodeToText`, `langFromClassName`, `IMG_HREF_RE`, `isExternalUrl`, entire `buildMdComponents` factory (~170 lines)
**Add**: `import { Markdown } from "@plugins/primitives/plugins/markdown/web"`
**Replace**: `<ReactMarkdown ...>{seg.text}</ReactMarkdown>` → `<Markdown>{seg.text}</Markdown>`

All enhancements auto-activate via slots. Active-data pre-split pipeline (`useActiveDataSegments`, `ActiveDataIdentityProvider`) stays in `AssistantTextRow` — it's external to `<Markdown>`.

### Result — every consumer is identical:

```tsx
<Markdown>{text}</Markdown>
```

## Verification

1. `./equin build` — clean compile
2. Conversation transcript → rendering identical; code blocks highlighted; inline code chips (active-data, file paths) still work
3. File-pane markdown preview → code blocks now syntax-highlighted (new); file-path links still clickable
4. Debug memory panel → code blocks now syntax-highlighted (new); slightly larger headings (standardised)
5. External links open in `_blank` on all surfaces
6. `rg "import ReactMarkdown" plugins/` → only the markdown primitive
