# SSE v3: sync `subscribe` + typed `SseHandler<T>`

## Context

The unified multiplex (v1 — `2026-04-14-global-unified-sse-multiplex.md`) shipped with `SseHandler.subscribe` allowed to return a `Promise<() => void>`. That made the core `/api/events` handler's `ReadableStream.start` async, which Bun honours by delaying the response body flush, which caused a tight reconnect loop (v2 — `2026-04-14-global-unified-sse-multiplex-v2.md`). The current workaround (fire-and-forget Promise handling in sync `start`) works but keeps the footgun loaded: the next async `subscribe` reintroduces the same class of failure.

The deeper mistake is conflating **subscription** (a sender joining a fan-out room — registration, O(1), infallible) with **resource acquisition** (finding the worktree path, reading the DB — I/O, fallible, may take time). Every modern pub/sub primitive keeps these separate: `EventEmitter.on`, `addEventListener`, RxJS `subscribe`, Go channels — none do I/O at subscribe time.

Also, `send: (data: unknown) => void` is untyped. `/api/tasks/stream` emits `{type:"changed"}`, `/api/conversations/stream` emits `{type:"working",…}`, and the compiler can't tell the difference. A fresh design should carry the wire type through the handler.

**Goal:** `SseHandler<T>.subscribe` is synchronous and typed. Any I/O belongs at server boot (pre-wired deps) or inside the producer's tick loop — never at subscribe time.

## Design

### Narrower, typed handler interface

`server/src/types.ts`:

```ts
export interface SseHandler<T = unknown> {
  subscribe(
    send: (data: T) => void,
    params: Record<string, string>,
  ): () => void;
}
```

- Return type narrowed to `() => void`. No Promise branch.
- Generic `T` defaults to `unknown` so existing call sites compile, but each plugin declares its wire shape: `SseHandler<ConversationEvent>`, `SseHandler<EditedFilesResponse>`, `SseHandler<TasksEvent>`.
- `sseRoutes?: Record<string, SseHandler>` on `ServerPluginDefinition` stays un-generic (heterogeneous map). The generic only matters at the handler's point of use.

### Core multiplex simplifies

`server/src/index.ts`:

- `start` stays synchronous (already is).
- Drop the `typeof result === "function"` / `result.then(...)` Promise branch entirely — `subscribe` now returns `() => void` unconditionally.
- `enqueueFn = (bytes) => …` let-reassignment goes away: `start` captures the controller directly into the send closure it passes to each `subscribe`. Heartbeat `setInterval` starts *inside* `start(controller)` once the controller is in hand.

The handler body collapses to roughly:

```ts
start(controller) {
  controller.enqueue(encoder.encode(": ok\n\n"));
  const heartbeat = setInterval(() => {
    if (!closed) controller.enqueue(PING);
  }, HEARTBEAT_MS);
  const cleanup = () => { /* clearInterval + run unsubs */ };
  for (const virtualUrl of virtualUrls) {
    const match = resolveSse(virtualUrl);
    if (!match) { /* not-found frame */ continue; }
    const name = escapeEventName(virtualUrl);
    const send = (data: unknown) =>
      controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
    try {
      unsubs.push(match.handler.subscribe(send, match.params));
    } catch (err) {
      console.error(`[sse] subscribe threw for ${virtualUrl}`, err);
    }
  }
},
cancel() { cleanup(); }
```

Synchronous throws from `subscribe` are logged and skipped; the other subscriptions still flow. This is the normal error surface now — not a Promise rejection swallowed via `.then(_, err => …)`.

### Pre-wire the worktree root at boot

`plugins/conversations/server/internal/worktree.ts`:

- Rename `getMainWorktreeRoot()` → `ensureMainWorktreeRoot()` (still async, still cached). Intent is clearer: "make sure the cache is warm."
- Add `worktreePathForSync(id: string): string` — pure string concat against the cached root. Throws if called before `ensureMainWorktreeRoot()` resolved (guard against lifecycle mistakes).
- Keep `worktreePathFor(id)` for any caller outside the SSE path (e.g. `setupWorktree`).

`server/src/index.ts`:

- At top-level, right after `await runMigrations()`:
  ```ts
  await ensureMainWorktreeRoot();
  ```
  Both are already top-level awaits. Adds ~10 ms one-time at boot.

### Edited-files handler becomes sync

`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-stream.ts`:

The current async `subscribe` does two things we can eliminate:

1. **DB lookup** for `worktreePath` — replace with `worktreePathForSync(id)`. The existence check is redundant: if the worktree directory doesn't exist, `getEditedFiles` already handles it gracefully (returns empty / logs on tick). If the conversation id is bogus the path is bogus, `getEditedFiles` errors in the tick loop, the room stays empty. Same user-observable behaviour.

2. **Immediate snapshot `await getEditedFiles(...)`** — replaced by two cases:
   - **Room already exists** (another subscriber is listening): `send(JSON.parse(room.lastSerialized))` synchronously from the cache. New subscriber gets the latest known state on the same tick.
   - **New room**: `startRoom` kicks off the `setInterval`, but *also* schedules an eager `tick(id, room)` via `queueMicrotask` (fire-and-forget). First frame arrives on the next microtask + DB/FS round-trip, typically < 50 ms. No worse than today's `await getEditedFiles` inside `subscribe`.

The handler becomes:

```ts
export const editedFilesStreamHandler: SseHandler<EditedFilesResponse> = {
  subscribe(send, params) {
    const id = params.id;
    if (!id) return () => {};
    const worktreePath = worktreePathForSync(id);
    const room = getOrCreateRoom(id, worktreePath);
    room.subscribers.add(send);
    if (room.lastSerialized) {
      try { send(JSON.parse(room.lastSerialized)); } catch {}
    } else if (room.subscribers.size === 1) {
      queueMicrotask(() => tick(id, room).catch((err) =>
        console.error("[code.edited-files-stream] initial tick failed", err)));
    }
    startRoom(room, id);
    return () => { … };
  },
};
```

### Type the other handlers

Zero-cost, follow-through:

- `plugins/conversations/server/internal/sse.ts` → `conversationsStreamHandler: SseHandler<ConversationEvent>` (type already imported from `../../shared/protocol`).
- `plugins/tasks/server/internal/sse.ts` → define `TasksEvent = { type: "changed" }` in `plugins/tasks/shared/protocol.ts` (new file, mirroring conversations), export `tasksStreamHandler: SseHandler<TasksEvent>`. Client consumer (`plugins/tasks/web/components/tasks-list.tsx:48-59`) already ignores the payload, but the type is now discoverable.

Client-side type inference (plumbing `T` into `ReconnectingEventSource`) is out of scope for this plan — it's a separate refactor touching `plugin-core/reconnecting-event-source.ts` and every consumer. Call it SSE v4 if/when wanted.

## Critical files

- `server/src/types.ts` — narrow `SseHandler` to sync return; add `<T>` generic.
- `server/src/index.ts` — drop Promise branch; `await ensureMainWorktreeRoot()` before `Bun.serve`; move heartbeat setup inside `start(controller)`.
- `plugins/conversations/server/internal/worktree.ts` — rename getter; add `worktreePathForSync`; throw if called un-primed.
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-stream.ts` — sync `subscribe`; remove DB lookup; snapshot-from-cache or eager `queueMicrotask` tick.
- `plugins/conversations/server/internal/sse.ts` — type parameter.
- `plugins/tasks/shared/protocol.ts` — new, exports `TasksEvent`.
- `plugins/tasks/server/internal/sse.ts` — type parameter + import.

No client-side changes. No doc regeneration beyond what `./equin build` emits automatically.

## Verification

1. `./equin build` — deploys.
2. `./equin check` — all four checks pass (`migrations-in-sync`, `plugins-doc-in-sync`, `no-raw-event-source`, `no-raw-sse`).
3. Open `/c/<id>` in Chrome; DevTools → Network filtered on `/api/events`. Expect exactly two requests over the page lifetime (`urls=stream`, then `urls=stream,edited-files`), both staying open, `: ping` every ~20 s, zero `ERR_INCOMPLETE_CHUNKED_ENCODING`.
4. Toggle between two conversations 10× rapidly — one reopen per switch, no retries.
5. Edit a file in the conversation's worktree → counter updates within ~1 s. Open the conversation for the first time → first edited-files frame arrives within ~100 ms (snapshot-on-subscribe path).
6. TypeScript: introduce a deliberate wire-type mismatch (`send({ wrong: true })` inside `editedFilesStreamHandler.subscribe`) → expect `tsc` error. Revert.
7. Grep `text/event-stream` repo-wide → still only `server/src/index.ts`, `cli/src/checks/no-raw-sse.ts`, and `research/` docs.
