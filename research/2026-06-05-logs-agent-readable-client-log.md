# Agent-readable `clientLog` primitive (browser → per-worktree JSONL file)

## Context

Agents (Claude) debugging this app cannot see browser `console.log` output without
driving a Playwright browser. The motivating case: the build button's
`"Server restarting…"` state never appears, and its label is a pure client-side
derivation (`building && wsStatus !== "open"`, `plugins/build/web/components/build-button.tsx:54-62`)
— so the only way to know *why* it never renders is to observe the browser's
sequence of `(building, wsStatus, staleTab)` values. We want a `console.log`-style
primitive whose output an agent can read **without a browser**, and that survives the
worktree backend restart that `./equin build` performs mid-build.

### The load-bearing constraint (why this is file-based, not MCP-based)

An agent's `mcp__singularity__*` calls dial `http://${SINGULARITY_PARENT_HOST}.localhost:9000/...`
(`.mcp.json`), and `SINGULARITY_PARENT_HOST` is set to the **launching** backend's
worktree (`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:608-654`,
`parentHost = Bun.env.SINGULARITY_WORKTREE`). For a top-level agent launched from the
agent-manager, that is **not** the agent's own fresh worktree backend. So an MCP tool
reading **in-memory** state would read the *wrong process*.

The write side has no such problem: the agent's app is served from
`<wt>.localhost:9000`, so a same-origin `POST` from the browser lands on **that
worktree's** backend. The fix mirrors `query_db` (which reaches any worktree because
Postgres is shared, addressable storage): persist logs to the **shared filesystem**
at `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl`, and the agent reads that file
with `tail`/`cat`. No MCP, no process-topology nuance, survives any kill.

### Scope (this pass)

**Logging primitive only.** Build `clientLog` + per-worktree JSONL append-on-write +
Bash read, and use the build button as the first customer. **Deferred** to a follow-up:
the unified `inspect` MCP tool and folding `get_runtime_profile` into it (see
*Deferred* below).

## Architecture

```
 Browser (<wt>.localhost:9000)            Worktree <wt> backend                 Agent
 ────────────────────────────            ─────────────────────                 ─────
 clientLog("build-btn", line)
   └─ in-mem buffer ──flush──▶  POST /api/logs/emit ──▶ Log.emit(channel, line, t)
      • debounced ~250ms                                   │
      • flush on WS reconnect                              ├─▶ ring buffer (UI /ws/logs pane)
        (captures lines emitted                            │
         while backend was down)                           └─▶ appendFileSync  ─────────────┐
                                                                ~/.singularity/worktrees/    │
 server code: Log.channel(id,{persist:true}).publish(...) ─────▶ <wt>/logs/<channel>.jsonl   │
                                                                                              ▼
                                                                          tail/cat (Bash) ◀──┘
```

- **Write path is worktree-correct by construction**: same-origin POST → this worktree's
  backend → this worktree's `SINGULARITY_WORKTREE` → this worktree's file.
- **In-memory ring is retained** only to feed the existing live UI logs pane
  (`/ws/logs`, `plugins/debug/plugins/logs/web/components/log-viewer.tsx`); durability and
  agent-readability come from the file, so **no `onShutdown` flush is needed**.
- **Append-on-write** (not onShutdown-only) is required because the agent reads the file
  while the worktree backend is still alive, and because it survives SIGKILL/OOM.

## Implementation (all in `plugins/debug/plugins/logs/`, except the build-button customer)

### 1. Channel registry: get-or-create + optional persistence
`plugins/debug/plugins/logs/server/internal/registry.ts`
- Keep `createChannel(id)` throwing on duplicate (line 25 — server code relies on it).
- Extract the publish closure into `makePublisher(internal)` and add
  `getOrCreateChannel(id, opts?: { persist?: boolean }): LogChannel` returning a
  `LogChannel` over the existing-or-new internal record. Browser channels are created
  lazily by id and re-emitted to, so they need get-or-create.
- Add a `persist: boolean` field to the internal channel. When set, `publish()` ALSO
  appends the entry to disk (see persist.ts). `publish()` accepts an optional
  `timestamp` override so the **client emit time** (not server-receive time) is recorded
  — this matters for ordering lines captured across the restart window.

### 2. Per-worktree JSONL persistence
`plugins/debug/plugins/logs/server/internal/persist.ts` (new)
- `appendEntry(channel, { t, stream, line })` →
  `dir = join(SINGULARITY_DIR, "worktrees", process.env.SINGULARITY_WORKTREE, "logs")`,
  `mkdirSync(dir, { recursive: true })`,
  `appendFileSync(join(dir, sanitize(channel) + ".jsonl"), JSON.stringify({ t, stream, line }) + "\n")`.
  Idiom from `plugins/build/server/internal/run-build.ts:125-143` and
  `plugins/crashes/server/internal/buffer.ts:18-29`.
- `sanitize(channel)` — replace any char not in `[A-Za-z0-9_-]` with `_` to prevent
  path traversal (channel ids come from the browser). **Security-load-bearing.**
- Guard missing `SINGULARITY_WORKTREE` (no-op or throw loudly).

### 3. `Log.emit` + channel persist option
`plugins/debug/plugins/logs/server/internal/log.ts`
- Extend `Log`:
  - `emit(channelId, line, stream?, t?)` → `getOrCreateChannel(channelId, { persist: true }).publish(line, stream, t)`.
    (Client ingress is always persisted — that's the whole point.)
  - `channel(id, opts?: { persist?: boolean })` — pass `persist` through; default `false`
    so existing server channels keep current (in-memory-only) behavior unless they opt in.

### 4. Browser → server ingress endpoint
`plugins/debug/plugins/logs/core/endpoints.ts` (+ export from `core/index.ts`)
- Mirror the crashes precedent (`plugins/crashes/shared/endpoints.ts` + `handle-report.ts`):
  ```ts
  export const EmitLogsBodySchema = z.object({
    channel: z.string().min(1).max(128),
    lines: z.array(z.object({
      line: z.string(),
      stream: z.enum(["stdout", "stderr"]).optional(),
      t: z.number(),                 // client emit time (ms) — preserved on disk
    })).min(1).max(500),
  });
  export const emitLogs = defineEndpoint({ route: "POST /api/logs/emit", body: EmitLogsBodySchema });
  ```
`plugins/debug/plugins/logs/server/internal/handle-emit.ts` (new)
- `implement(emitLogs, async ({ body }) => { for (const l of body.lines) Log.emit(body.channel, l.line, l.stream, l.t); })`
  (void → 204).
`plugins/debug/plugins/logs/server/index.ts`
- Add `[emitLogs.route]: handleEmit` to `httpRoutes`.

### 5. Browser `clientLog` primitive (buffer + reconnect-flush)
`plugins/debug/plugins/logs/web/client-log.ts` (new, module singleton; export from `web/index.ts`)
- `const buffer = new Map<string, { line; stream?; t }[]>()`.
- `export function clientLog(channel, line, stream?) { buffer.get(channel).push({ line, stream, t: Date.now() }); scheduleFlush(); }`.
- `scheduleFlush()` — ~250ms debounce; `flush()` drains per channel and POSTs via
  `fetchEndpoint(emitLogs, {}, { body: { channel, lines } })`. On POST failure, **re-queue**
  the drained lines (so lines emitted while the backend is down are retried). Fire-and-forget
  is correct here (self-correcting); use `void` per promise-safety lint.
- **Reconnect flush (load-bearing for the build-button case):** subscribe to the global WS
  status bus `subscribeWsStatus` from `@plugins/primitives/plugins/networking/web`; on a
  transition to `open`, call `flush()`. This drains lines buffered during the restart window
  once the new backend is up. **Verify** the worktree channel publishes on that bus; if not,
  add a tiny `Core.Root` component using `useNotificationsChannelStatuses()`
  (`@plugins/primitives/plugins/live-state/web`) that calls `flush()` on `worktree === "open"`.

### 6. First customer — build button
`plugins/build/web/components/build-button.tsx`
- `import { clientLog } from "@plugins/debug/plugins/logs/web"` (legal cross-plugin barrel
  edge build→debug/logs; no cycle).
- After `status` is computed (line 62), in a `useEffect` keyed on the derived values:
  `clientLog("build-btn", JSON.stringify({ status, building, wsStatus, staleTab, finishedAt: latestRun?.finishedAt }))`.
- This both validates the primitive and captures the trace that answers the original
  question (does `wsStatus` ever leave `"open"` while `building` is true?).

## Key decisions (baked in)

- **File-first, append-on-write** — agent reads the live file; survives any kill; no
  `onShutdown` needed. In-memory ring kept only for the UI pane.
- **Client emit time `t` persisted** — so lines captured across the restart window order
  correctly even though they POST after reconnect.
- **Channel name sanitized** before use as a filename (path-traversal guard).
- **Server-channel persistence is opt-in** (`Log.channel(id, { persist: true })`); client
  channels always persist.

## Deferred (follow-up plan)

- Unified `inspect` MCP tool (`defineInspectable` registry + single `inspect` tool, the
  non-SQL sibling of `query_db`) with a `logs` source that reads the **per-worktree JSONL**
  (worktree resolved from the MCP `conversationId` context — **not** the in-memory ring,
  per the topology constraint above), plus migrating `get_runtime_profile` into it as a
  second source. Design notes captured here for when scope expands.

## Verification

1. `./equin build` — must pass plugin-boundary / barrel-purity / DAG / eslint checks.
   New edges: build→debug/logs/web (web), debug/logs ingress route.
2. **Direct ingress** (no browser): from any client, `POST /api/logs/emit` with
   `{ channel: "smoke", lines: [{ line: "hi", t: <ms> }] }`, then
   `tail ~/.singularity/worktrees/att-1780609648-x5sb/logs/smoke.jsonl` → the line appears.
3. **Browser path:** load `http://att-1780609648-x5sb.localhost:9000`, in devtools call
   `clientLog("ui-smoke", "hello")` (or trigger a build-button render), then
   `tail ~/.singularity/worktrees/att-1780609648-x5sb/logs/ui-smoke.jsonl` — line present,
   read by the agent **without Playwright**.
4. **Restart durability + the original bug:** drive a manual build via the build button
   (Playwright click), which SIGTERM-restarts this backend. After the new backend boots and
   the worktree WS reconnects, inspect
   `~/.singularity/worktrees/att-1780609648-x5sb/logs/build-btn.jsonl` ordered by `t`:
   - If `wsStatus` never leaves `"open"` while `building` is true → the gateway holds the
     browser socket open through the restart (the premise of `build-button.tsx:38-40` is
     wrong for the worktree channel) → that's why `"Server restarting…"` never shows.
   - If there are rows with `wsStatus` ∈ {reconnecting, closed} and `building: true` → the
     state exists but isn't being rendered/derived as expected.
   Either way the file gives the definitive trace, not speculation.

## Critical files

- `plugins/debug/plugins/logs/server/internal/registry.ts` — getOrCreateChannel + persist flag + publish timestamp override (keep createChannel throw at line 25)
- `plugins/debug/plugins/logs/server/internal/persist.ts` — **new**, per-worktree JSONL append + channel-name sanitize
- `plugins/debug/plugins/logs/server/internal/log.ts` — `Log.emit` + `channel(id, {persist})`
- `plugins/debug/plugins/logs/core/endpoints.ts` — `emitLogs` endpoint + body schema
- `plugins/debug/plugins/logs/server/internal/handle-emit.ts` — **new**, implement emit
- `plugins/debug/plugins/logs/server/index.ts` — register the emit route
- `plugins/debug/plugins/logs/web/client-log.ts` — **new**, `clientLog` buffer + reconnect-flush
- `plugins/debug/plugins/logs/web/index.ts` — export `clientLog`
- `plugins/build/web/components/build-button.tsx` — first customer instrumentation
