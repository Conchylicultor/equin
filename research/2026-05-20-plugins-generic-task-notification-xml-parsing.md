# Generic XML parsing for task-notification events

## Context

The JSONL transcript parser in `transcript-watcher` extracts `<task-notification>` blocks from user messages using hand-rolled per-tag regexes for exactly four inner tags (`task-id`, `tool-use-id`, `status`, `summary`). If Claude Code ever adds a new child tag, it's silently dropped. Replace the regex approach with `fast-xml-parser` so parsing is proper XML and automatically forwards unknown tags via an `extra` bag.

## Files to modify

| File | Change |
|---|---|
| `plugins/conversations/plugins/transcript-watcher/package.json` | Add `fast-xml-parser` dependency |
| `plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts` | Replace inner-tag regexes with `XMLParser` |
| `plugins/conversations/plugins/transcript-watcher/core/protocol.ts` | Add `extra: z.record(z.string()).optional()` to the schema |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/task-notification/web/components/task-notification-row.tsx` | Render extra entries as pills |

## Implementation

### 1. Add dependency

Add `"fast-xml-parser": "^4.5.0"` to `transcript-watcher/package.json` dependencies. Run `bun install`.

### 2. Replace parsing in `parse-jsonl.ts`

- Import `XMLParser` from `fast-xml-parser`.
- Create a module-level instance: `new XMLParser({ parseTagValue: false, trimValues: true })`. Using `parseTagValue: false` keeps all values as strings — no numeric coercion surprises.
- Keep the outer regex (`/<task-notification>([\s\S]*?)<\/task-notification>/g`) — its job is to locate XML fragments within arbitrary message text, which a parser can't do.
- For each matched block, `xmlParser.parse(block)` returns `{ "task-notification": { "task-id": "...", ... } }`.
- Extract known keys (`task-id` → `taskId`, etc.) with fallbacks matching current behavior.
- Collect remaining keys into `extra: Record<string, string>`, omitting the field when empty.
- Wrap parse in try/catch — skip malformed blocks gracefully.

### 3. Update Zod schema in `protocol.ts`

Add after `summary`:
```ts
extra: z.record(z.string()).optional(),
```

The `JsonlEvent` type updates automatically via `z.infer`.

### 4. Update renderer in `task-notification-row.tsx`

After the `<span className="truncate">{e.summary}</span>`, conditionally render extra entries:

```tsx
{e.extra && Object.entries(e.extra).map(([k, v]) => (
  <span key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
    {k}: {v}
  </span>
))}
```

No-op when `extra` is undefined (the common case today).

## Edge cases

- **Nested XML in extras**: `fast-xml-parser` returns objects for nested tags. The `str()` coercion returns `""` for objects, silently dropping them from `extra`. Acceptable — deeply nested structures are not expected in this protocol.
- **HTML entities**: `fast-xml-parser` decodes standard XML entities (`&amp;`, `&lt;`, etc.) by default. Strictly better than raw regex which returned encoded text.
- **Empty blocks**: If `<task-notification></task-notification>` appears with no children, the parser returns an empty string. The existing guard (`if (taskId || status || summary)`) skips it, same as before.

## Verification

1. `./equin build` — confirm it compiles and deploys
2. Open a conversation that has active background agents (task notifications appear in the JSONL stream)
3. Confirm existing task-notification rows render identically (taskId chip, colored status, summary text)
4. To test the `extra` bag: temporarily inject a test `<task-notification>` block with an unknown tag and confirm it appears as a pill in the row
