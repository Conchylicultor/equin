# Active-Data Unified Rendering

**Date:** 2026-05-01  
**Status:** Design  
**Scope:** `plugins/active-data/`, `plugins/.../assistant-text/`

---

## Context

Active-data lets sub-plugins replace raw text in assistant messages with React components: a conversation ID becomes a chip, a `<task>` tag becomes an editable card. Two rendering modes co-exist today:

- **Pattern mode** (`conv-xxx`) — walks rendered React children post-render and splices in the component. Works well.
- **Tag mode** (`<task>…</task>`) — registers custom components in react-markdown's component map, relying on `rehype-raw` + parse5 to route the HTML tag to the right renderer. Broken for multi-line content.

The tag mode bug: CommonMark's Type-7 HTML block terminates at a blank line, and Type-7 blocks cannot interrupt a paragraph. So `</task>` after an internal blank line lands as *inline HTML inside the following paragraph* rather than a sibling block. When `hast-util-raw` feeds all siblings through one shared parse5 parser, parse5 encounters `</task>` while `<p>` (a "special" element) is current and silently drops it — leaving the outer `<task>` open, so the second `<task>` nests inside the first.

The current workaround (`remarkMergeCustomTagBlocks`) manually serializes mdast nodes back to raw HTML to re-join the split fragments. It works for the common cases but is architecturally wrong: serializing an AST back to text to undo a parsing decision is a code smell, and the serializer is incomplete (drops images, footnotes, nested HTML, etc.).

The root cause is that tag mode is using CommonMark's HTML block passthrough — a mechanism designed for raw HTML snippets, not custom React components — to route multi-line content to a UI widget. That mismatch is unfixable within the markdown pipeline.

---

## Core Insight

Both modes do the same thing: **match a span of raw text and replace it with a React component.** The difference is rendering context:

| | Pattern mode | Tag mode |
|---|---|---|
| Match | regex on rendered text nodes | `<tag>…</tag>` in raw string |
| Appears | inline within prose | between blank lines (block) |
| Content | the matched string | the text between tags |
| Pipeline fit | ✓ linkify works | ✗ HTML block passthrough breaks |

The fix is not to patch the tag pipeline — it's to **stop using the markdown pipeline for block-level custom elements** and instead pre-extract them from the raw string before CommonMark sees them.

---

## Proposed Design

### Two display contexts, two mechanisms

```
         raw text
             │
      ┌──────┴──────┐
  pre-extract     passes through
  block tags       to CommonMark
      │                 │
  block segments    markdown segments
      │                 │
  direct render    ReactMarkdown
                       │
                  linkify inline
                   patterns
```

**Block extraction** (for `<tag>…</tag>` contributions):  
Regex-split the raw string at `<tag>…</tag>` boundaries before markdown parsing. Each match becomes a `{ type: 'block' }` segment rendered directly — completely outside the markdown pipeline. Blank lines inside the tag are trivially handled: they're just characters in the matched string.

**Inline linkify** (for `pattern` contributions):  
Unchanged. Walks rendered ReactNode children and splices in components. Correct because inline patterns appear within prose, inside already-parsed paragraphs.

---

## New Contribution Contract

```ts
// plugins/active-data/web/slots.ts

// Block tag: content extracted at raw-string level, rendered outside markdown.
export interface ActiveDataBlockContribution {
  display: 'block';
  tag: string;
  component: ComponentType<{
    content: string;               // plain text between the tags (trimmed)
    attrs: Record<string, string>; // parsed tag attributes
  }>;
}

// Inline pattern: matched against rendered text nodes, replaced in place.
export interface ActiveDataInlineContribution {
  display: 'inline';
  pattern: RegExp;  // must have the `g` flag
  component: ComponentType<{
    content: string;               // the matched substring
    attrs: Record<string, string>; // always {}
  }>;
}

export type ActiveDataContribution =
  | ActiveDataBlockContribution
  | ActiveDataInlineContribution;

export const ActiveData = {
  Tag: defineSlot<ActiveDataContribution>("active-data.tag"),
};
```

**Why `content` instead of `children`:** React's `children` prop implies React children (nodes, elements). The component receives a plain string — naming it `content` removes that ambiguity and is accurate for both modes.

**Why explicit `display`:** Makes the rendering path unambiguous at the contribution declaration site. Prevents hybrid contributions that blur the two mechanisms. Serves as documentation.

---

## New Host API

### `useActiveDataSegments(rawText: string)`

```ts
// plugins/active-data/web/internal/segment-active-data.ts

export type ActiveDataSegment =
  | { type: 'markdown'; text: string }
  | {
      type: 'block';
      component: ComponentType<{ content: string; attrs: Record<string, string> }>;
      content: string;
      attrs: Record<string, string>;
    };

export function useActiveDataSegments(rawText: string): ActiveDataSegment[];
```

Implementation:
1. Collect all `display: 'block'` contributions.
2. Build a combined regex: `<(tag1|tag2|…)(\s[^>]*)?>[\s\S]*?<\/\1>` with `g` flag.
3. Walk `rawText`, collecting non-match spans as `{ type: 'markdown' }` and matches as `{ type: 'block', content: innerText, attrs: parsedAttrs }`.
4. Skip empty markdown segments (blank inter-tag gaps).

### `useActiveDataLinkify()` — unchanged

No change to the inline linkify mechanism. It is called within each markdown segment's render.

---

## How the Host Renders

```tsx
// assistant-text-row.tsx (simplified)

const segments = useActiveDataSegments(e.text);
const linkify = useActiveDataLinkify();

return (
  <>
    {segments.map((seg, i) =>
      seg.type === 'block' ? (
        <seg.component key={i} content={seg.content} attrs={seg.attrs} />
      ) : (
        <ReactMarkdown
          key={i}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[]}          // no rehype-raw needed
          components={buildMdComponents(linkify)}
        >
          {seg.text}
        </ReactMarkdown>
      )
    )}
  </>
);
```

**rehype-raw is no longer needed** for active-data. If assistant text never needs raw HTML passthrough for other reasons, remove it entirely. If it stays for other reasons, it no longer interacts with active-data at all.

---

## What Is Deleted

| File / export | Reason |
|---|---|
| `remarkMergeCustomTagBlocks` | The whole remark workaround disappears |
| `useActiveDataComponents()` | Replaced by `useActiveDataSegments()` |
| `makeAdapter` / `nodeToText` | No longer extracting text from React children |
| `rehypeRaw` in the host | Not needed for active-data tag routing |
| `test-parse.ts` | Debugging artifact, should be deleted regardless |

---

## Migration

### `conv` sub-plugin (no change needed)
Rename `display` is the only schema touch:
```ts
// Before
ActiveData.Tag({ pattern: CONV_ID_RE, component: ConvChip })
// After
ActiveData.Tag({ display: 'inline', pattern: CONV_ID_RE, component: ConvChip })
```
Component props are unchanged (`children: string` → `content: string` rename, but functionally identical).

### `task` sub-plugin
```ts
// Before
ActiveData.Tag({ tag: 'task', component: TaskCard })
// After
ActiveData.Tag({ display: 'block', tag: 'task', component: TaskCard })
```
`TaskCard` receives `content: string` instead of `children: string`. The Lexical editor seeded from the initial value is unchanged — just a prop rename.

---

## Invariants for Future Contributions

1. **Block contributions** (`display: 'block'`) must use a `tag`. Content is always a plain string. The component must not depend on receiving React children from the markdown pipeline.
2. **Inline contributions** (`display: 'inline'`) must use a `pattern` with the `g` flag. The matched span must be short (a single token or ID). Do not use inline contributions for multi-line or block-level content.
3. No contribution should rely on `nodeToText`, `makeAdapter`, or any React-children-to-text conversion. That was an anti-pattern made necessary by the old tag mode.
4. No contribution should require `rehype-raw` to function.
5. Block tag content passes through the host unchanged — it is NOT parsed as markdown. If a block contribution needs markdown rendering of its content, it must run a second `ReactMarkdown` instance inside its own component.

---

## Files to Change

| File | Change |
|---|---|
| `plugins/active-data/web/slots.ts` | New union type, `display` field |
| `plugins/active-data/web/internal/segment-active-data.ts` | New file: `useActiveDataSegments` |
| `plugins/active-data/web/internal/render-active-data.tsx` | Delete after migration |
| `plugins/active-data/web/index.ts` | Export `useActiveDataSegments`, remove `useActiveDataComponents`, `remarkMergeCustomTagBlocks` |
| `plugins/active-data/plugins/task/web/index.ts` | `display: 'block'` |
| `plugins/active-data/plugins/task/web/components/task-card.tsx` | `children` → `content` prop |
| `plugins/active-data/plugins/conv/web/index.ts` | `display: 'inline'` |
| `plugins/active-data/plugins/conv/web/components/conv-chip.tsx` | `children` → `content` prop |
| `…/assistant-text/web/components/assistant-text-row.tsx` | Use `useActiveDataSegments`, remove `useActiveDataComponents`, remove `remarkMergeCustomTagBlocks`, remove `rehypeRaw` |
| `web/src/__tests__/active-data-task-parsing.test.tsx` | Rewrite to test `useActiveDataSegments` directly (no react-markdown needed) |

---

## Verification

```bash
# Unit tests
cd web && bun run test src/__tests__/active-data-task-parsing.test.tsx

# Full build (type-checks everything)
./equin build

# Manual: open a conversation where the model emitted <task> tags
# with blank lines in the description — verify two independent cards render
```
