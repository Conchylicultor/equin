---
name: JSONL viewer plugin for the conversation toolbar
date: 2026-04-23
category: plugins
---

# JSONL viewer plugin

## Context

The conversation view currently exposes the Claude session through the tmux runtime (raw terminal output) and, via `GET /api/conversations/:id/turns`, a simplified `Turn[]` of user/assistant text only. Neither surface shows tool calls, tool results, or system events that Claude writes to its JSONL session log at `~/.claude/projects/<encoded-project>/<session-id>.jsonl`.

We want a toolbar button on the conversation view that, when clicked, opens a right pane rendering the full JSONL transcript in a human-readable form — including `tool_use` and `tool_result` blocks — so users can inspect the full agent trace without reading raw terminal output.

**Design choices (confirmed with user):**
- **Display area:** right pane (sidebar), like `tasks-panel` / `docs-button`.
- **Content detail:** full transcript with tool calls (not just text turns).
- **Button style:** icon-only.

## Implementation

New plugin: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/` (sibling of `tasks-panel`, `resume`, etc.).

### 1. Server: parse full JSONL events

Existing helpers to reuse:
- `findTranscriptPath(sessionId)` — `plugins/conversations/server/internal/claude-transcript.ts:23`
- `getConversationClaudeSessionId(id)` — exported from `@plugins/tasks-core/server`
- Route registration pattern — `plugins/conversations/server/internal/handle-list-turns.ts:4` (chains the two helpers above)

`readTurns()` throws away tool_use/tool_result/system content, so we need a new parser. Add a new function in a new file **in the new plugin**, not in the shared `claude-transcript.ts`, since this level of detail is specific to the viewer.

**New file:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/parse-jsonl.ts`

```ts
// Kept intentionally lossy-light: preserve the structural shape of the
// original Claude JSONL so the client can render tool calls/results without
// re-parsing noise. One entry per JSONL line that we can display.
export type JsonlEvent =
  | { kind: "user-text";    at: string; text: string }
  | { kind: "user-tool-result"; at: string; toolUseId: string; content: string; isError?: boolean }
  | { kind: "assistant-text"; at: string; messageId?: string; text: string; stopReason?: string }
  | { kind: "assistant-tool-use"; at: string; messageId?: string; toolUseId: string; name: string; input: unknown }
  | { kind: "system";       at: string; subtype?: string; text: string }
  | { kind: "summary";      at: string; text: string };

export async function readJsonlEvents(path: string): Promise<JsonlEvent[]>
```

Parser rules:
- Read file with `Bun.file(path).text()`, split on `\n`, `JSON.parse` per line, skip malformed.
- For each entry with `type: "user"`:
  - `message.content: string` → `user-text`
  - `message.content: Array` → emit one `user-tool-result` per block of `{type: "tool_result"}` (content is string or array of `{type:"text",text}` — concatenate text chunks).
- For each entry with `type: "assistant"`:
  - Walk `message.content[]`; for `{type:"text"}` emit `assistant-text` (same `messageId` chunks concat into one entry, matching the merging logic in `readTurns()` at lines 88–103); for `{type:"tool_use"}` emit `assistant-tool-use`.
- For `type: "system"` → `system` (pull `subtype` + text if present).
- For `type: "summary"` → `summary`.
- Ignore unknown types.

**New file:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/handle-list-events.ts`

Mirrors `handle-list-turns.ts` (same 404/empty handling):
```ts
export async function handleListEvents(_req, params) {
  const claudeSessionId = await getConversationClaudeSessionId(params.id);
  if (claudeSessionId === undefined) return new Response("Not found", { status: 404 });
  if (!claudeSessionId) return Response.json({ events: [] });
  const path = await findTranscriptPath(claudeSessionId);
  if (!path) return Response.json({ events: [] });
  return Response.json({ events: await readJsonlEvents(path) });
}
```

**New file:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/index.ts`

```ts
const plugin: ServerPluginDefinition = {
  id: "conversation-jsonl-viewer",
  name: "Conversation: JSONL viewer",
  httpRoutes: {
    "GET /api/conversations/:id/jsonl": handleListEvents,
  },
};
```

**Shared types:** export `JsonlEvent` from a `shared/index.ts` so the web side can import it without depending on server code. Follow the pattern of `plugins/conversations/plugins/conversation-view/plugins/code/shared/` (see `editedFilesResource`/`EditedFile` type split).

### 2. Web: icon-only button + right pane

Follow `tasks-panel` verbatim for the scaffolding:

**New files:**
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/package.json` — `"@singularity/plugin-jsonl-viewer"`
- `web/index.ts` — `PluginDefinition` contributing `Conversation.Toolbar({ component: JsonlButton })`
- `web/views.tsx` — `jsonlRightPane(): RightPaneDescriptor` with `JsonlPane` component
- `web/components/jsonl-button.tsx` — mirror `tasks-button.tsx:1`
  - Use `MdDataObject` (or `MdOutlineDataObject`) from `react-icons/md`
  - `useRightPane()` + `Conversation.OpenRightPane(isOpen ? null : jsonlRightPane())`
  - `title="JSONL transcript"` / `aria-label="JSONL transcript"`
- `web/components/jsonl-pane.tsx` — fetches `/api/conversations/:id/jsonl` on mount (plain `fetch` + `useState`, matching `docs-pane.tsx:11`), renders close-button header, then a scrollable list
- `web/components/event-row.tsx` — switch on `event.kind`, render each variant with appropriate styling:
  - `user-text` / `assistant-text` — chat-bubble style (tailwind, mirror existing muted/foreground tokens; no new colors)
  - `assistant-tool-use` — tool name pill + `<pre>` of `JSON.stringify(input, null, 2)` in a `<details>`
  - `user-tool-result` — "→ result" block with content inside a `<details>`, red tint if `isError`
  - `system` — small muted italic line
  - `summary` — divider with label

No streaming / live updates for v1 — click refresh (or reopen) to reload. A simple reload button in the header is fine and cheap.

### 3. Register the plugin

- `web/src/plugins.ts` — add import + push onto `plugins[]` (alongside `conversationTasksPanelPlugin`).
- `server/src/plugins.ts` — add import + push onto `plugins[]` (alongside `quickPromptsPlugin`).
- `docs/plugins.md` — add entry under `conversation-view` nested plugins with the contribution and `GET /api/conversations/:id/jsonl` route.

## Files to modify

- NEW: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/{package.json, server/index.ts, server/internal/{parse-jsonl.ts, handle-list-events.ts}, shared/index.ts, web/{index.ts, views.tsx, components/{jsonl-button.tsx, jsonl-pane.tsx, event-row.tsx}}}`
- EDIT: `web/src/plugins.ts` (register frontend plugin)
- EDIT: `server/src/plugins.ts` (register server plugin)
- EDIT: `docs/plugins.md` (document the new contribution + route)

## Verification

1. `./equin build` — must succeed (types, drizzle, frontend build, server restart).
2. Open `http://<worktree>.localhost:9000` → open any conversation that has had a few Claude turns.
3. Click the new icon-only button in the conversation toolbar.
4. Verify the right pane opens and shows user messages, assistant messages, and at least one `tool_use` block with its input JSON collapsible.
5. Click the button again — pane closes. Navigate to another conversation — pane reflects the new conversation's events.
6. Open a conversation with no Claude session yet (freshly created) — pane shows an empty/loading state, not a crash. The handler returns `{ events: [] }` with 200 in that case.
7. Scripted Playwright run to confirm:

   ```bash
   bun e2e/screenshot.mjs \
     --url http://<worktree>.localhost:9000/c/<id> \
     --click "JSONL transcript" \
     --out /tmp/jsonl
   ```

   The matched button state and `-before.png` / `-after.png` should show the pane opening.
