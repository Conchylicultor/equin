# `file.ts:148` Clickable References with Line Highlighting

## Context

Assistant text frequently contains references like `plugins/infra/plugins/claude-cli/server/run-claude-print.ts:148`. Plain file paths (without `:N`) are already clickable via the `file-links` primitive and open the file-peek pane. This plan threads line numbers through the full chain so `file.ts:148` opens the pane scrolled to and highlighting line 148.

8 files across 4 layers. All changes are backward-compatible. No new files, no new plugins.

---

## Layer 1 — file-links parse

### `plugins/primitives/plugins/file-links/web/internal/parse.ts`

1. Extend `FILE_PATH_RE` to optionally capture a trailing `:\d+`. Insert `(?::(\d+))?` between the path group and the negative lookahead:
   ```ts
   export const FILE_PATH_RE =
     /(?<![\w./~:-])((?:~\/(?:[\w.\-]+\/)*|(?:[\w.\-]+\/)+)(?:[\w\-]*(?:\.[\w\-]+)+|Makefile|Dockerfile|Gemfile|Rakefile|Procfile|Brewfile))(?::(\d+))?(?![\w/-])/g;
   ```
   Group 1 = path, group 2 = optional line digits.

2. Add `line?: number` to `FileLinkSegment`:
   ```ts
   export interface FileLinkSegment {
     type: "text" | "path" | "url";
     value: string;       // clean path, no :N
     line?: number;
   }
   ```

3. In `parseFileLinks`, capture group 2 and include in path segments:
   ```ts
   while ((m = FILE_PATH_RE.exec(text)) !== null) {
     const lineNum = m[2] ? parseInt(m[2], 10) : undefined;
     raw.push({ index: m.index, end: m.index + m[0].length, type: "path", value: m[1] ?? "", line: lineNum });
   }
   // ...and when building final segments:
   segments.push({ type: r.type, value: r.value, line: r.line });
   ```

### `plugins/primitives/plugins/file-links/web/internal/file-link-text.tsx`

1. Update `onFileOpen` signature: `(path: string, line?: number) => void`
2. Pass `seg.line` on click: `onFileOpen(seg.value, seg.line)`
3. Show `:N` in chip label: `{seg.line != null ? `${seg.value}:${seg.line}` : seg.value}`

### `plugins/primitives/plugins/file-links/web/internal/linkify-children.tsx`

Update `onFileOpen` type to `(path: string, line?: number) => void` (pass-through; no logic changes).

---

## Layer 2 — file-pane host

### `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/file-open-context.tsx`

Update `FileOpenHandler`:
```ts
export type FileOpenHandler = (filePath: string, line?: number) => void;
```

### `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/slots.ts`

Add optional `line` to renderer component props (backward-compatible — existing renderers ignore it):
```ts
component: ComponentType<{ worktree: string; path: string; line?: number }>;
```

### `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/file-peek-pane.tsx`

Keep pane path unchanged (`"file/:worktree/:filePath*"`). Encode line in `filePath` as `path:N` suffix. Parse in body:
```ts
const { filePath: rawFilePath } = convFilePeekPane.useParams();
const lineMatch = rawFilePath.match(/:(\d+)$/);
const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
const filePath = lineMatch ? rawFilePath.slice(0, -lineMatch[0].length) : rawFilePath;
```

Update internal `onFileOpen` to accept and forward `line`:
```ts
const onFileOpen = (fp: string, ln?: number) =>
  convFilePeekPane.open({ convId, worktree, filePath: ln != null ? `${fp}:${ln}` : fp });
```

Pass `line` to `<FileContent>`.

### `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/components/file-content.tsx`

Accept `line?: number`, thread to renderer:
```tsx
export function FileContent({ worktree, path, line, active }: { ...; line?: number }) {
  const Component = active.contribution.component;
  return <Component worktree={worktree} path={path} line={line} />;
}
```

---

## Layer 3 — raw renderer

### `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/raw/web/components/raw-view.tsx`

1. Add `line?: number` to props.
2. Add `containerRef = useRef<HTMLDivElement>(null)`.
3. Add shiki transformer to mark lines; include `line` in the `useEffect` dep array that recomputes `html`:
   ```ts
   const out = hl.codeToHtml(content, {
     lang: resolvedLang,
     theme,
     transformers: line != null ? [{
       line(node, lineNum) {
         node.properties['data-line'] = String(lineNum);
         if (lineNum === line) node.properties['data-highlighted'] = '';
       },
     }] : [],
   });
   // Prepend style for highlighted line
   const styledHtml = line != null
     ? `<style>.shiki .line[data-highlighted]{background-color:rgba(255,210,0,0.15);display:block;width:100%}</style>${out}`
     : out;
   setHtml(styledHtml);
   ```
4. Add `useEffect` to scroll after render:
   ```ts
   useEffect(() => {
     if (line == null || !containerRef.current) return;
     containerRef.current
       .querySelector<HTMLElement>('[data-highlighted]')
       ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
   }, [line, html]);
   ```
5. Attach `ref={containerRef}` to the container div.

---

## Layer 4 — assistant-text entry point

### `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx`

Update `onFileOpen` to encode `line` in `filePath`:
```ts
const onFileOpen = (path: string, line?: number) =>
  convFilePeekPane.open({
    convId: conversation.id,
    worktree: conversation.attemptId,
    filePath: line != null ? `${path}:${line}` : path,
  });
```

Update `buildMdComponents` signature to match: `onFileOpen: (path: string, line?: number) => void`.

---

## Sequencing

1. `parse.ts`
2. `file-link-text.tsx`
3. `linkify-children.tsx`
4. `file-open-context.tsx`
5. `slots.ts`
6. `file-content.tsx`
7. `file-peek-pane.tsx`
8. `raw-view.tsx`
9. `assistant-text-row.tsx`

---

## Verification

- [ ] `./equin build` — no type errors
- [ ] Plain `plugins/foo/bar.ts` links still open (no line, no scroll) 
- [ ] `plugins/foo/bar.ts:148` renders as a clickable chip showing `bar.ts:148`
- [ ] Clicking opens file-peek pane; URL includes `:148` suffix in filePath param
- [ ] Line 148 has amber/yellow highlight background
- [ ] Pane auto-scrolls line 148 to vertical center
- [ ] Navigating to a different `:N` link re-scrolls
- [ ] Image, diff, markdown tabs open without errors (they receive `line` but ignore it)
