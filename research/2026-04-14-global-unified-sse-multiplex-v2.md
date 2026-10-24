# Unified SSE multiplex — followup: bugs found and cleanup options

Followup to [`2026-04-14-global-unified-sse-multiplex.md`](./2026-04-14-global-unified-sse-multiplex.md). After the first implementation landed and was deployed, opening a conversation triggered a ~2 Hz reconnect loop on `/api/events`. This doc explains the bug, why the workaround works, and what the clean version looks like.

## What was observed

Loading `/c/<id>` produced this network pattern (one entry per `EventSource` connection attempt, ~120–530 ms apart):

```
+1278ms  /api/events?urls=stream
+1416ms  /api/events?urls=stream,edited-files          ← URL set changed
+1936ms  /api/events?urls=stream,edited-files          ← retry after onerror
+2051ms  /api/events?urls=stream                       ← URL set changed back
+2585ms  /api/events?urls=stream                       ← retry after onerror
+2722ms  /api/events?urls=stream,edited-files          ← URL set changed again
… loops forever
```

Console: `net::ERR_INCOMPLETE_CHUNKED_ENCODING` 2 ms after each `200 OK`, alternating with `net::ERR_ABORTED` from the client's intentional close.

## Root cause: async `start` on `ReadableStream`

The `/api/events` handler used `async start(controller)` and awaited each plugin's `subscribe` in sequence:

```ts
async start(controller) {
  controller.enqueue(": ok\n\n");
  for (const url of virtualUrls) {
    const unsub = await match.handler.subscribe(send, params);  // ← awaits DB
    unsubs.push(unsub);
  }
  …
}
```

`/api/conversations/stream` resolves synchronously, but the edited-files handler does `await db.select(...).from(conversations).where(eq(conversations.id, id))` to look up the conversation's worktree path. That made `start` return a pending promise.

Per the Web Streams spec, when `start` returns a promise the implementation may delay flushing the response body until that promise resolves. Bun does. Result: Chromium received the 200 headers, then the body stalled mid-stream, and Chrome fired `onerror` on the `EventSource` ~3 ms after `onopen`.

A native `EventSource` would have backed off and reconnected ~3 s later (it did, in a controlled isolated test). But our `ReconnectingEventSource` overrides that — it closes the failing `EventSource` and reopens with a 500 ms backoff. So the recovery is much faster, and a transient open/error cycle becomes a tight loop.

## The amplification loop

The 500 ms backoff alone wouldn't have produced the alternating URL set. Two app-level feedbacks turned it into a self-sustaining cycle:

1. Each new connection emits status `connecting → open` (no `reconnecting`). But after the *first* `onerror`, attempt count is bumped, and the next connection emits `reconnecting → open`. `ConversationView` (`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:38-46`) subscribes to `/api/conversations/stream` status changes and, on `reconnecting → open`, re-fetches the conversation:

   ```ts
   if (status === "open" && wasReconnecting) fetchConversation();
   ```

2. `fetchConversation` calls `setConversation(null)` immediately, before the new fetch resolves (`conversation-view.tsx:17`). The toolbar is rendered as `{conversation && toolbarItems.map(...)}` — flipping `conversation` to `null` *unmounts the entire toolbar*, including `EditedFilesButton`. That runs `useEditedFiles`'s cleanup (`use-edited-files.ts:23`), which calls `es.close()` on the edited-files `ReconnectingEventSource`, which removes the URL from the multiplex, which triggers a reopen.

   Then the fetch resolves, `setConversation(row)` re-mounts the toolbar, `EditedFilesButton` mounts again, `useEditedFiles` opens a new `ReconnectingEventSource`, the URL is re-added, the multiplex reopens. Each new connection runs into the same async-`start` issue → another `onerror` → `reconnecting → open` → another `fetchConversation` → loop.

So the bug had three layers: (1) server-side `async start` causing transient connection drops, (2) client-side `ReconnectingEventSource` retrying aggressively on those drops, (3) downstream consumer (`ConversationView`) tearing down its UI on `reconnecting → open` and unmounting/remounting subscribers.

## The deployed fix (workaround-shaped)

`server/src/index.ts` now uses a synchronous `start` that flushes `: ok\n\n` immediately, calls each handler's `subscribe` without awaiting, and registers async `subscribe` returns when their promises resolve:

```ts
const result = match.handler.subscribe(send, match.params);
if (typeof result === "function") unsubs.push(result);
else result.then(
  (unsub) => closed ? unsub() : unsubs.push(unsub),
  (err) => console.error(err),
);
```

The heartbeat and `cleanup()` live as plain closures outside `start` and are torn down by the stream's `cancel`.

This works. But there's seam: `enqueueFn` is a `let`-reassigned closure (heartbeat is created before `start` runs but needs the controller from inside `start`), and the multiplex carries Promise-handling code that exists solely to accommodate one async handler.

## Cleaner alternatives

### Option A — Make `SseHandler.subscribe` synchronous; pre-warm the path lookup

`worktreePathFor(id)` (`plugins/conversations/server/internal/worktree.ts:23`) is async only on its very first call (it spawns `git worktree list` once to find the main repo root, then caches the result). The DB lookup in `edited-files-stream` is mostly there as a "does this conversation exist?" guard.

Steps:
1. Split `worktreePathFor` into `ensureMainWorktreeRoot()` (async, await once at server startup) and `worktreePathForSync(id)` (cheap string concat).
2. Call `ensureMainWorktreeRoot()` from `server/src/index.ts` before `Bun.serve(...)`.
3. In `edited-files-stream.subscribe`, drop the DB query and use `worktreePathForSync(params.id)`. If the directory doesn't exist, `getEditedFiles` already handles it (returns empty / errors logged on tick).
4. Narrow the interface:
   ```ts
   interface SseHandler {
     subscribe(send: (data: unknown) => void, params: Record<string, string>): () => void;
   }
   ```
5. Delete the Promise-handling branch in `server/src/index.ts`.

**Cost:** ~10 lines net. **Benefit:** simpler contract; the whole class of "subscribe is slow → response stalls" bugs is structurally impossible.

**Risk:** if a future plugin genuinely needs async work at subscription time (e.g. acquire an external resource), this option blocks it. Mitigation: such plugins can do the async work *lazily on first `send`*, not on subscribe — see Option B.

### Option B — Keep `subscribe` sync; defer slow work to first tick

Same interface change as A, but instead of pre-warming, plugins that need async setup do it inside their tick/poll loop the first time:

```ts
function subscribe(send, params) {
  let worktreePath: string | null = null;
  const room = rooms.get(params.id) ?? createRoom(params.id);
  room.subscribers.add(send);
  // tick (separate timer) lazily resolves worktreePath on first run, then proceeds
  return () => { room.subscribers.delete(send); … };
}
```

**Cost:** ~12 lines, mostly in `edited-files-stream.ts`. **Benefit:** same contract simplification as A, and supports plugins that fundamentally need async setup. **Risk:** plugins now have to think about "what if subscribe is called and unsub fires before my async work finishes?" — the same race the multiplex handler currently absorbs.

### Option C — Keep `SseHandler.subscribe` async; extract a `Subscription` class

Don't change the interface. Clean up the seam in `server/src/index.ts` by extracting:

```ts
class SseSubscription {
  private closed = false;
  private unsubs: Array<() => void> = [];
  constructor(private controller: ReadableStreamDefaultController<Uint8Array>) {}
  send(bytes: Uint8Array) {
    if (this.closed) return;
    try { this.controller.enqueue(bytes); } catch { this.cleanup(); }
  }
  attach(result: ReturnType<SseHandler["subscribe"]>) {
    if (typeof result === "function") this.unsubs.push(result);
    else result.then(
      (u) => this.closed ? u() : this.unsubs.push(u),
      (err) => console.error(err),
    );
  }
  cleanup() { … }
}
```

`start` becomes three lines. Heartbeat lives on `SseSubscription`. **Cost:** ~30 lines (a small class). **Benefit:** structure is clearer if a second call site shows up. **Risk:** none, but doesn't *prevent* the next person from accidentally turning `start` async again — that footgun stays in place, only the local complexity moves around.

## Recommendation

**Option A.** It removes a footgun rather than relocating it: `start` cannot accidentally become async because there's no async work to call. The cost is one synchronous helper and one server-startup `await`. The DB-existence check we'd lose is barely load-bearing — `getEditedFiles` already degrades gracefully on a missing path.

If/when a second SSE handler genuinely needs async setup, revisit with Option B.

## Critical files

- `server/src/index.ts` — drop Promise branch in `start`; await `ensureMainWorktreeRoot()` before `Bun.serve`.
- `server/src/types.ts` — narrow `SseHandler.subscribe` return type to `() => void`.
- `plugins/conversations/server/internal/worktree.ts` — split into `ensureMainWorktreeRoot` + `worktreePathForSync`.
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-stream.ts` — make `subscribe` synchronous; remove DB lookup.

## Verification

1. `./equin build`.
2. Open `/c/<any-id>` in Chrome; DevTools → Network filtered to `/api/events`. Expect exactly two requests over the lifetime of the page: `urls=stream` then `urls=stream,edited-files`. Both stay open. Periodic `: ping` frames every ~20 s.
3. Toggle between two conversations rapidly. Expect one reopen per switch, no retries.
4. Edited-files counter still updates within ~1 s of touching a file in the worktree.
5. `./equin check` passes.
