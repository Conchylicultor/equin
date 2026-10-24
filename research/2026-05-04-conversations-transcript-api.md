# Conversation Transcript API Plugin

## Context

When agents need to inspect a conversation's full JSONL session log, there is currently no direct way to get the on-disk file path from a conversation ID. The multi-step workaround (DB query → claude_session_id → glob ~/.claude/projects/) is slow to discover and requires internal knowledge of the storage layout.

A focused sub-plugin with a clear description lets any agent find and call `GET /api/conversations/:id/transcript` to get the path in one shot.

## Design

New server-only sub-plugin: `plugins/conversations/plugins/transcript-api/`

**Plugin description** (shown in plugin registry, read by agents):
> "Agent API: GET /api/conversations/:id/transcript returns the on-disk JSONL path for a conversation's full raw Claude session transcript."

**Response shape:**
- `200 { path: string }` — absolute path to the `.jsonl` file
- `200 { path: null }` — conversation exists but Claude session not started yet (no file written)
- `404` — conversation ID not found

## Files to Create / Modify

### 1. Export `findTranscriptPath` from the conversations barrel

**`plugins/conversations/server/index.ts`** — add to the existing named exports:
```ts
export { findTranscriptPath } from "./internal/claude-transcript";
```

### 2. New sub-plugin

**`plugins/conversations/plugins/transcript-api/server/index.ts`**
```ts
import type { ServerPluginDefinition } from "@server/types";
import { handleTranscript } from "./internal/handle-transcript";

export default {
  id: "conversations-transcript-api",
  name: "Conversation Transcript API",
  description:
    "Agent API: GET /api/conversations/:id/transcript returns the on-disk JSONL path for a conversation's full raw Claude session transcript.",
  httpRoutes: {
    "GET /api/conversations/:id/transcript": handleTranscript,
  },
} satisfies ServerPluginDefinition;
```

**`plugins/conversations/plugins/transcript-api/server/internal/handle-transcript.ts`**
```ts
import { getConversationClaudeSessionId } from "@plugins/tasks-core/server";
import { findTranscriptPath } from "@plugins/conversations/server";

export async function handleTranscript(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const { id } = params;
  const claudeSessionId = await getConversationClaudeSessionId(id);
  if (claudeSessionId === undefined) return new Response("Not found", { status: 404 });
  if (!claudeSessionId) return Response.json({ path: null });
  const path = await findTranscriptPath(claudeSessionId);
  return Response.json({ path });
}
```

No `package.json` needed — the sub-plugin has no additional dependencies beyond workspace packages already available.

## Key Reused Functions

- `getConversationClaudeSessionId(id)` — `@plugins/tasks-core/server` — maps conversation id → `claude_session_id`, returns `undefined` if row missing, `null` if session not started
- `findTranscriptPath(sessionId)` — `plugins/conversations/server/internal/claude-transcript.ts` — globs `~/.claude/projects/*/${sessionId}.jsonl`, returns absolute path or `null`

## Verification

```bash
./equin build
# Then:
curl http://singularity.localhost:9000/api/conversations/conv-1777882733-ycaj/transcript
# Expected: {"path":"/Users/epot/.claude/projects/.../c65255dc-....jsonl"}
```
