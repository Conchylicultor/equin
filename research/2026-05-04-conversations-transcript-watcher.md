# Collapse dual JSONL pollers into `transcript-watcher`

## Context

Two server processes independently poll each conversation's JSONL transcript at 500 ms:

- `plugins/conversations/server/internal/turn-emitter.ts` — detects `end_turn` messages and emits `conversation.turn-completed` for durable jobs. Contains a hand-rolled `extractEndTurns()` that re-implements parsing from `parse-jsonl.ts` (cross-plugin internal imports are forbidden).
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/watch-jsonl.ts` — streams `JsonlEvent[]` to the UI via the `jsonl-events` live-state resource.

Both re-read the same files, re-parse them independently, at the same cadence: doubled filesystem load per active conversation, drift risk between two independent parsers, architectural smell.

Fix: a new `plugins/conversations/plugins/transcript-watcher/` plugin that replaces both pollers with a `@parcel/watcher`-based file watcher and a single fan-out API.

---

## 1. New plugin: `plugins/conversations/plugins/transcript-watcher/`

### Location rationale
Sibling of `jsonl-viewer` under the `conversations` umbrella. Not `infra` — this is JSONL-format-specific, not a general-purpose infrastructure primitive.

### Type migration
`JsonlEvent` (and related: `JsonlEventSchema`, `TokenUsage`, `UserTextSegment`, `JsonlEventsPayloadSchema`) currently lives in `jsonl-viewer/shared/protocol.ts`. Since `transcript-watcher` produces these types, they must originate here — otherwise `transcript-watcher` would have to import from `jsonl-viewer`, creating a dependency cycle (`jsonl-viewer` → `transcript-watcher` → `jsonl-viewer`).

**Move to `transcript-watcher/shared/protocol.ts`.**

`jsonl-viewer/shared/protocol.ts` is updated to import `JsonlEventSchema` from `@plugins/conversations/plugins/transcript-watcher/shared` instead of defining it, keeping only `jsonlEventsResource`, `JsonlEventsResponse`, and `JsonlEventsPayloadSchema` (the live-state resource descriptor, which belongs to jsonl-viewer).

All jsonl-viewer sub-plugins that import `JsonlEvent` from `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/shared` update the import to `@plugins/conversations/plugins/transcript-watcher/shared`.

### `readJsonlEvents` migration
`parse-jsonl.ts` moves from `jsonl-viewer/server/internal/` to `transcript-watcher/server/internal/`. It is exported from the transcript-watcher server barrel. `jsonl-events-resource.ts` imports it from `@plugins/conversations/plugins/transcript-watcher/server`.

### Parcel subscription design
One `parcel.subscribe(CLAUDE_PROJECTS_DIR, callback)` for the entire plugin — not per-conversation — mirroring `git-watcher`'s pattern. On a file change event, look up which room owns that path via a `pathToConversationId: Map<string, string>` reverse index. If found, re-read + re-parse + fan out.

### Room lifecycle
```ts
interface Room {
  conversationId: string;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  lastMtimeMs: number;
  lastEvents: JsonlEvent[];
  subscribers: Set<(events: JsonlEvent[]) => void>;
  pathRetryTimer: ReturnType<typeof setInterval> | null; // only while path is unknown
}
```

- **First subscriber** → room created; async seed: `findTranscriptPath` → if found, read + parse + fan out + register path in reverse index. If not found (file not yet created), start a 1 s retry timer. Retry timer is cleared once path is found.
- **Late subscriber** → receives `lastEvents` snapshot immediately via `queueMicrotask` (same as current `watch-jsonl.ts`).
- **Last unsubscribe** → room removed, path removed from reverse index, retry timer cleared.

### Server restart recovery
On room creation the seed read fires the callback immediately with the current file state. This covers any `end_turn` events that landed while the server was down — the `hasPrimed` + `hasPendingTrigger` logic in `turn-emitter` hooks into this seed callback exactly as it currently hooks into the first polling tick.

A 30 s reconcile timer (`setInterval`) re-reads all open rooms regardless of parcel events, as a safety net for missed notifications on edge-case filesystems (same pattern as `git-watcher`'s `RECONCILE_INTERVAL_MS`).

### Plugin definition
```ts
// server/index.ts
export default {
  id: "conversation-transcript-watcher",
  name: "Conversation: Transcript Watcher",
  description: "Single @parcel/watcher-based JSONL transcript watcher. Replaces two independent pollers with one fan-out subscription.",
  onReady: startTranscriptWatcher,   // opens parcel subscription + reconcile timer
  onShutdown: stopTranscriptWatcher, // unsubscribes + clears timers + clears rooms
} satisfies ServerPluginDefinition;
```

### Exported API (server barrel)
```ts
export { watchTranscript } from "./internal/watcher";
export { readJsonlEvents } from "./internal/parse-jsonl";
```

`watchTranscript(conversationId: string, onChange: (events: JsonlEvent[]) => void): () => void`

---

## 2. Changes to `jsonl-viewer`

### `jsonl-events-resource.ts`
- `onFirstSubscribe`: replace `watchJsonl(id, ...)` with `watchTranscript(id, () => jsonlEventsResource.notify({ id }))` — the callback still ignores the events arg and just triggers a notify (which re-runs the loader), matching the current behaviour.
- `onLastUnsubscribe`: call the returned unsubscribe.
- `loader`: replace `import { readJsonlEvents } from "./parse-jsonl"` with `import { readJsonlEvents } from "@plugins/conversations/plugins/transcript-watcher/server"`. Logic unchanged.

### Files deleted
- `server/internal/watch-jsonl.ts` — replaced by `transcript-watcher`
- `server/internal/parse-jsonl.ts` — moved to `transcript-watcher/server/internal/`

### Import updates
- `shared/protocol.ts`: remove `JsonlEvent`, `JsonlEventSchema`, `TokenUsage`, `UserTextSegment` definitions; import `JsonlEventSchema` from `@plugins/conversations/plugins/transcript-watcher/shared`.
- All jsonl-viewer child plugins that import `JsonlEvent`: `assistant-text`, `assistant-thinking`, `assistant-tool-use`, `user-text`, `user-image`, `user-tool-result`, `system`, `summary`, `fork-session` — update import to `@plugins/conversations/plugins/transcript-watcher/shared`.

---

## 3. Changes to `turn-emitter`

### What stays
The DB poll (`listConversationsForInfra`) to discover active conversations and drive subscription lifecycle. Poll cadence relaxes from 500 ms → 5 s (no longer reads files, just manages a subscription set).

### What changes
The `RoomState` interface, `pollRoom` function, and `extractEndTurns` function are deleted. The `rooms` map changes from `Map<string, RoomState>` to `Map<string, () => void>` (conversationId → unsubscribe).

The `hasPrimed` + `hasPendingTrigger` logic is preserved but moves into the `watchTranscript` callback closure:

```ts
async function subscribeToConversation(conversationId: string): Promise<() => void> {
  let hasPrimed = false;
  const emittedIds = new Set<string>();

  return watchTranscript(conversationId, async (events) => {
    const endTurns = events
      .filter((e): e is JsonlEvent & { kind: "assistant-text" } => e.kind === "assistant-text")
      .filter((e) => e.stopReason === "end_turn" && !!e.messageId);

    if (!hasPrimed) {
      for (const t of endTurns) if (t.messageId) emittedIds.add(t.messageId);
      hasPrimed = true;
      if (endTurns.length > 0 && (await hasPendingTrigger(conversationId))) {
        const latest = endTurns[endTurns.length - 1];
        if (latest?.messageId) await emitTurnCompleted(conversationId, latest);
      }
      return;
    }

    for (const t of endTurns) {
      if (!t.messageId || emittedIds.has(t.messageId)) continue;
      emittedIds.add(t.messageId);
      await emitTurnCompleted(conversationId, t);
    }
  });
}
```

`emitTurnCompleted` is a small extracted helper wrapping the existing `conversationTurnCompleted.emit(...)` call. The `tick` function replaces `pollRoom(id)` with `subscribeToConversation(id)` for new IDs and calls the stored unsubscribe for evicted IDs.

---

## File inventory

### New files
| File | Role |
|------|------|
| `plugins/conversations/plugins/transcript-watcher/package.json` | workspace stub (`@singularity/plugin-conversations-transcript-watcher`) |
| `plugins/conversations/plugins/transcript-watcher/CLAUDE.md` | plugin docs |
| `plugins/conversations/plugins/transcript-watcher/shared/index.ts` | shared barrel |
| `plugins/conversations/plugins/transcript-watcher/shared/protocol.ts` | `JsonlEvent` + related types (moved from jsonl-viewer) |
| `plugins/conversations/plugins/transcript-watcher/server/index.ts` | server barrel + plugin definition |
| `plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts` | parcel subscription, rooms, `watchTranscript`, reconcile timer |
| `plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts` | `readJsonlEvents` (moved from jsonl-viewer) |

### Modified files
| File | Change |
|------|--------|
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/shared/protocol.ts` | remove type definitions; import `JsonlEventSchema` from transcript-watcher |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-events-resource.ts` | swap `watchJsonl` → `watchTranscript`; update `readJsonlEvents` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-thinking/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-tool-use/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-image/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-tool-result/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/system/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/summary/**` | update `JsonlEvent` import |
| `plugins/conversations/plugins/conversation-view/plugins/fork-session/**` | update `JsonlEvent` import if used |
| `plugins/conversations/server/internal/turn-emitter.ts` | replace file-read loop + `extractEndTurns` with `watchTranscript` subscriptions; relax poll to 5 s |

### Deleted files
| File | Reason |
|------|--------|
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/watch-jsonl.ts` | replaced by transcript-watcher |

(`parse-jsonl.ts` is moved, not deleted — it becomes `transcript-watcher/server/internal/parse-jsonl.ts`.)

---

## Verification

1. `./equin build` — no TypeScript errors
2. `./equin check --plugin-boundaries` — no cross-plugin boundary violations
3. `./equin check --eslint` — no lint errors
4. Open an active conversation in the UI: JSONL viewer renders correctly and streams new events without page reload
5. Trigger `push-and-exit`: durable job resumes correctly after turn completes (normal `hasPrimed` path)
6. Restart the server during an active conversation, then complete a turn: `push-and-exit` still resolves (server restart recovery / `hasPendingTrigger` path)
