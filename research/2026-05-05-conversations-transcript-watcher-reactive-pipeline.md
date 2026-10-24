# Refactor: transcript-watcher reactive resolution pipeline

## Context

`seedRoom()` in the transcript-watcher plugin is a procedural state machine that manually orchestrates a multi-step resolution (sessionId → filePath → register → process) with ad-hoc retry logic. A recent bug: when `claudeSessionId` wasn't in the DB yet, it returned silently with no retry — the room stayed permanently disconnected.

The root cause isn't the missing retry — it's that the abstraction forces manual enumeration of every "what's resolved / what's not" combination. Adding another timer compounds the problem. The fix: replace the state machine with a linear async pipeline where each stage is a self-contained "poll until resolved" concern.

## Design

### New `Room` struct

```ts
interface Room {
  conversationId: string;
  transcriptPath: string | null;  // set once resolved
  lastMtimeMs: number;
  lastEvents: JsonlEvent[];
  subscribers: Set<Listener>;
  abort: AbortController;         // cancels the pipeline on close
}
```

Removed: `claudeSessionId` (local to the pipeline), `pathRetryTimer` (replaced by AbortController).

### `pollUntil` — generic async retry primitive

```ts
async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  opts: { intervalMs: number; signal: AbortSignal },
): Promise<T> {
  while (!opts.signal.aborted) {
    const result = await fn();
    if (result != null) return result;
    await Bun.sleep(opts.intervalMs);
  }
  throw new DOMException("Aborted", "AbortError");
}
```

Mirrors the `awaitPgReady()` pattern in `server/src/db/client.ts`.

### `resolveRoom` — the pipeline (replaces `seedRoom` + `retryPath`)

```ts
async function resolveRoom(room: Room): Promise<void> {
  const { signal } = room.abort;

  const sessionId = await pollUntil(
    () => getConversationClaudeSessionId(room.conversationId),
    { intervalMs: 1_000, signal },
  );

  const path = await pollUntil(
    () => findTranscriptPath(sessionId),
    { intervalMs: 1_000, signal },
  );

  registerPath(room, path);
  await processRoom(room);
}
```

Each stage blocks until satisfied, then falls through. No branching, no nullable state.

### Cancellation

`closeRoom` → `room.abort.abort()` → `pollUntil` loop exits → `resolveRoom` throws `AbortError` → caught silently at call site. No timers to track.

## Implementation steps

1. **Replace Room struct** — remove `claudeSessionId`, `pathRetryTimer`; add `abort: AbortController`.
2. **Add `pollUntil`** — file-private utility, not exported.
3. **Replace `seedRoom` + `retryPath` with `resolveRoom`** — call site in `watchTranscript`:
   ```ts
   void resolveRoom(room).catch((err) => {
     if (err instanceof DOMException && err.name === "AbortError") return;
     console.error(`[transcript-watcher] resolveRoom failed for ${room.conversationId}`, err);
   });
   ```
4. **Update `closeRoom`** — `room.abort.abort()` instead of `clearInterval`.
5. **Update `stopTranscriptWatcher`** — loop calls `room.abort.abort()` instead of clearing timers.
6. **Remove `PATH_RETRY_MS` constant** — interval is inlined (or kept as a single `POLL_MS` constant if preferred).

## What stays the same

- Public API: `watchTranscript(id, onChange) → unsubscribe`
- Single `parcel.subscribe(CLAUDE_PROJECTS_DIR)` for all rooms
- 30s reconcile timer on rooms with a `transcriptPath`
- `processRoom` (mtime-gated full read + fanOut)
- `registerPath` (room.transcriptPath + pathToConvId reverse index)
- Late-subscriber snapshot via `queueMicrotask`
- Restart resilience (full file re-read, no persistent cursor)
- Both consumers unchanged (jsonl-events-resource, turn-emitter)

## Critical files

- `plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts` — **only file modified**

## Verification

1. `./equin build` — compiles
2. Open existing conversation in JSONL viewer — events stream
3. Create brand-new conversation (bug case) — events appear after session ID is written to DB
4. Kill + restart server — events resume on reconnect
5. Close conversation pane — no lingering async loops after abort
