# Unified Markdown Primitive

## Context

Three files independently import ReactMarkdown and define nearly identical Tailwind component maps (~80% shared styling). Each adds its own subset of extensions (syntax highlighting, file links, active data, image proxy). This duplication makes styling inconsistent and extensions hard to compose.

The goal: a single `<Markdown text={...} />` component that works everywhere without consumers passing any configuration. Extensions inject behavior via the standard slot mechanism and read their own React context internally.

## Extension Mechanism

### Slot + hooks-in-contributions pattern

The markdown primitive defines a `Markdown.Extension` slot. Extensions contribute objects with hook-shaped properties (`useTransform`, `useCodeHandler`, `useComponents`). The `<Markdown>` component calls these hooks in a fixed-order loop during render. This is safe because contributions are static (registered at module load, never change at runtime), so the hook count is constant across renders.

```ts
type MarkdownExtension = {
  id: string;
  priority?: number;       // lower = applied first; default 100

  // Component overrides — merged into base; last priority wins per key.
  // code/pre are NOT overridable here — use useCodeHandler.
  useComponents?: () => Partial<Components>;

  // Children transform for text-bearing elements (h1-h6, p, li, blockquote, th, td).
  useTransform?: () => ((children: ReactNode) => ReactNode) | null;

  // Code element handlers composed by the internal code component.
  useCodeHandler?: () => CodeHandler | null;
};

type CodeHandler = {
  block?: (text: string, lang: string | null) => ReactNode | null;
  inline?: (text: string) => ReactNode | null;
};
```

### How `<Markdown>` composes extensions

1. Collect `Markdown.Extension.useContributions()`, sort by priority
2. Call each extension's `useTransform()` → chain results: `t3(t2(t1(children)))`
3. Call each extension's `useCodeHandler()` → collect block/inline handler arrays
4. Call each extension's `useComponents()` → merge onto base components (later priority wins per key)
5. Build the internal `code` component using collected handlers
6. Build base components using the chained transform
7. Overlay component overrides onto base
8. Render `<ReactMarkdown remarkPlugins={[remarkGfm]} components={merged}>{text}</ReactMarkdown>`

### Internal `code` component

The `code`/`pre` elements are NOT contributed by extensions — they're built internally by `<Markdown>` using collected code handlers:

- **Block code** (has `language-*` className or content contains `\n`): iterate `block` handlers by priority; first non-null wins. Fallback: `<pre class="styled"><code>text</code></pre>`.
- **Inline code**: iterate `inline` handlers by priority; first non-null wins (stripping the `<code>` wrapper). Fallback: `<code class="styled">children</code>`.
- `pre` always strips its wrapper (`<>{children}</>`) since the `code` component handles all wrapping.

## Extensions

### 1. Syntax Highlight (priority 50)

Contributes in `plugins/primitives/plugins/syntax-highlight/web/index.ts`.

```ts
useCodeHandler: () => ({
  block: (text, lang) => <HighlightedCode code={text} lang={lang} />,
})
```

No context needed — purely stateless.

### 2. Active Data — inline (priority 100)

Contributes in `plugins/active-data/web/index.ts`.

```ts
useTransform: () => useActiveDataLinkify(),  // already returns (children) => ReactNode
useCodeHandler: () => ({
  inline: (text) => {
    const result = linkify(text);
    return result !== text ? <>{result}</> : null;
  },
})
```

No additional context — `useActiveDataLinkify()` reads from `ActiveData.Tag` contributions which are globally available.

Active-data **block** segments (`useActiveDataSegments`) stay in `AssistantTextRow` — they require conversation-specific identity wrapping (`ActiveDataIdentityProvider`) that doesn't belong in a generic markdown component.

### 3. File Links (priority 200)

Contributes in `plugins/primitives/plugins/file-links/web/index.ts`.

New context: `FileOpenContext` — a `createContext<((path: string, line?: number) => void) | null>(null)` exported from the file-links barrel. Call sites provide it; the extension reads it internally.

```ts
useTransform: () => {
  const onFileOpen = useFileOpen() ?? undefined;
  return (children) => linkifyChildren(children, onFileOpen);
},
useCodeHandler: () => {
  const onFileOpen = useFileOpen();
  return {
    inline: (text) => {
      // URL in inline code → <a>
      if (text.startsWith("http://") || text.startsWith("https://")) {
        return <a href={text} target="_blank" ...>{text}</a>;
      }
      // File path in inline code → <button> (only when onFileOpen available)
      if (onFileOpen) {
        const segs = parseFileLinks(text);
        if (segs.length === 1 && segs[0].type === "path") {
          return <button onClick={() => onFileOpen(segs[0].value, segs[0].line)} ...>...</button>;
        }
      }
      return null;
    },
  };
},
useComponents: () => {
  const onFileOpen = useFileOpen();
  return onFileOpen ? { a: makeFileLinksAnchor(onFileOpen) } : {};
}
```

Also requires `FileLinkText` to gracefully handle `onFileOpen` being undefined (render file paths as styled `<span>` instead of `<button>`).

### 4. Image Proxy (priority 50)

Contributes in `plugins/code-explorer/web/index.ts`.

New context: `WorktreeContext` — a `createContext<string | null>(null)` exported from the code-explorer barrel. Set by conversation views.

```ts
useComponents: () => {
  const worktree = useWorktreeContext();
  const onFileOpen = useFileOpen(); // from file-links, for non-image fallback
  return worktree ? { img: makeProxiedImg(worktree, onFileOpen) } : {};
}
```

The `makeProxiedImg` factory returns a component that:
- External URL + image ext → `<img src={src}>`
- Local path + image ext → `<img src="/api/code/${worktree}/image?path=${src}">`
- Non-image path + onFileOpen → `<button onClick={() => onFileOpen(src)}>`
- Else → null (default img behavior)

## File Plan

### Create

| File | Purpose |
|------|---------|
| `plugins/primitives/plugins/markdown/package.json` | Workspace package |
| `plugins/primitives/plugins/markdown/web/index.ts` | Plugin definition + exports |
| `plugins/primitives/plugins/markdown/web/slots.ts` | `Markdown.Extension` slot, types |
| `plugins/primitives/plugins/markdown/web/internal/markdown.tsx` | `<Markdown>` component |
| `plugins/primitives/plugins/markdown/web/internal/base-components.tsx` | Shared Tailwind component map factory |
| `plugins/primitives/plugins/markdown/web/internal/types.ts` | `MarkdownExtension`, `CodeHandler` types |
| `plugins/primitives/plugins/file-links/web/internal/file-open-context.ts` | `FileOpenContext` + `useFileOpen` |
| `plugins/code-explorer/web/internal/worktree-context.ts` | `WorktreeContext` + `useWorktreeContext` |
| `plugins/primitives/plugins/syntax-highlight/web/internal/md-extension.tsx` | Syntax highlight code handler component |
| `plugins/primitives/plugins/file-links/web/internal/md-extension.tsx` | File-links extension (transform, code handler, anchor) |
| `plugins/active-data/web/internal/md-extension.tsx` | Active-data extension (transform, inline code handler) |
| `plugins/code-explorer/web/internal/md-extension.tsx` | Image proxy extension (img component) |

### Modify

| File | Change |
|------|--------|
| `plugins/primitives/plugins/syntax-highlight/web/index.ts` | Add `Markdown.Extension` contribution + export extension |
| `plugins/primitives/plugins/file-links/web/index.ts` | Add `Markdown.Extension` contribution, export `FileOpenContext`/`useFileOpen` |
| `plugins/active-data/web/index.ts` | Add `Markdown.Extension` contribution |
| `plugins/code-explorer/web/index.ts` | Add `Markdown.Extension` contribution, export `WorktreeContext`/`useWorktreeContext` |
| `plugins/primitives/plugins/file-links/web/internal/file-link-text.tsx` | Handle `onFileOpen` being undefined gracefully |
| `plugins/debug/plugins/memory/web/components/memory-panel.tsx` | Replace ReactMarkdown with `<Markdown>` |
| `plugins/conversations/.../markdown/web/components/markdown-view.tsx` | Replace ReactMarkdown with `<FileOpenContext.Provider><Markdown /></...>` |
| `plugins/conversations/.../assistant-text/web/components/assistant-text-row.tsx` | Replace inner ReactMarkdown with `<WorktreeContext.Provider><FileOpenContext.Provider><Markdown /></...>` |
| `web/src/plugins.ts` | Register markdown plugin |

## Implementation Steps

### Step 1: Create the markdown primitive plugin

Create `plugins/primitives/plugins/markdown/` with the slot definition, types, base components, and `<Markdown>` component. The base components consolidate the shared Tailwind styling from all three existing files. No extensions yet — just the bare bones.

### Step 2: Add `FileOpenContext` to file-links

Create the context file. Export from barrel. Modify `FileLinkText` to render `<span>` instead of `<button>` when `onFileOpen` is undefined.

### Step 3: Add `WorktreeContext` to code-explorer

Create the context file. Export from barrel.

### Step 4: Add extension contributions

Add `Markdown.Extension` contributions to syntax-highlight, file-links, active-data, and code-explorer. Each extension creates an internal `md-extension.tsx` with its handler components and provides the contribution in its barrel's `contributions` array.

### Step 5: Register the markdown plugin

Add import to `web/src/plugins.ts`.

### Step 6: Migrate memory-panel.tsx

Replace `ReactMarkdown` + `MD_COMPONENTS` with `<Markdown text={content} />`. Delete the `REMARK_PLUGINS` and `MD_COMPONENTS` constants. No context providers needed.

### Step 7: Migrate markdown-view.tsx

Replace `ReactMarkdown` + `buildComponents` with:
```tsx
<FileOpenContext.Provider value={onFileOpen}>
  <Markdown text={state.content} />
</FileOpenContext.Provider>
```
Delete `buildComponents`, `REMARK_PLUGINS`.

### Step 8: Migrate assistant-text-row.tsx

Keep `useActiveDataSegments` loop and `ActiveDataIdentityProvider` wrapping. Replace the inner `ReactMarkdown` and `buildMdComponents` with:
```tsx
<WorktreeContext.Provider value={conversation.attemptId}>
  <FileOpenContext.Provider value={onFileOpen}>
    <Markdown text={seg.text} />
  </FileOpenContext.Provider>
</WorktreeContext.Provider>
```
Lift providers outside the `segments.map` loop. Delete `buildMdComponents`, `nodeToText`, `langFromClassName`, `IMG_HREF_RE`, `isExternalUrl`, `REMARK_PLUGINS`. Remove direct imports of `HighlightedCode`, `linkifyChildren`, `parseFileLinks`, `useActiveDataLinkify` (they're now consumed by extensions internally).

### Step 9: Build and verify

Run `./equin build`, check all three surfaces in the browser.

## Verification

1. **Memory panel** (`/debug/memory`): Markdown renders with syntax highlighting for code blocks (new!), but no file links or active data (no context providers).
2. **File preview pane**: Open a `.md` file from a conversation's file list. File paths are clickable. Code blocks have syntax highlighting (new!).
3. **Assistant text**: Full feature set — syntax highlighting, file links, active data chips, image proxy. Toggle markdown off/on. Verify inline code patterns (conv-ids become chips, file paths become buttons, URLs become links).
4. Run `./equin check` — no plugin-boundary violations.
