# Terminal Backend Plugin

## Context

equin needs a terminal so users can interact with shells (and eventually Claude Code agents in worktrees). The server infrastructure exists — `Bun.serve()` on port 9001 with HTTP/WS routing and a `WsHandler` interface. This design covers the first server-side plugin: `plugins/terminal/server/`, which manages PTY sessions via `bun-pty` exposed over WebSocket.

## Architecture

```
Browser (xterm.js)  ──WebSocket /ws/terminal──>  WsHandler  ──>  PtyManager  ──>  bun-pty  ──>  Shell
```

One WebSocket connection = one PTY session. The handler enforces this 1:1 mapping.

## File Structure

```
plugins/terminal/
├── shared/
│   └── protocol.ts     # Message types — imported by both web/ and server/
├── server/
│   ├── index.ts        # WsHandler export — bridges WebSocket ↔ PTY manager
│   └── pty-manager.ts  # PTY lifecycle (create, write, resize, destroy)
└── web/                # (future — frontend plugin)
```

### Why `shared/`

The web and server tsconfigs have non-overlapping `include` scopes:
- **Web**: `../plugins/*/web` — cannot see `server/`
- **Server**: `../plugins/*/server` — cannot see `web/`

`protocol.ts` must be importable by both sides. Putting it in `shared/` and adding `../plugins/*/shared` to both tsconfig `include` fields solves this cleanly. No server-only dependencies (like `bun-pty`) leak into the frontend compilation.

**Tsconfig changes:**
- `web/tsconfig.app.json` `include`: add `"../plugins/*/shared"`
- `server/tsconfig.json` `include`: add `"../plugins/*/shared"`

This establishes a convention for future plugins that need cross-boundary types.

## `shared/protocol.ts` — Message Types

Discriminated unions for the WebSocket JSON protocol. Lives in `plugins/terminal/shared/` so both web and server can import it. Zero runtime dependencies.

**Client → Server:**

| type | fields | purpose |
|------|--------|---------|
| `session.create` | `cols, rows, cwd?` | Spawn a PTY |
| `session.input` | `sessionId, data` | Keystrokes → PTY stdin |
| `session.resize` | `sessionId, cols, rows` | Resize PTY |
| `session.destroy` | `sessionId` | Kill PTY |

**Server → Client:**

| type | fields | purpose |
|------|--------|---------|
| `session.created` | `sessionId` | Confirms spawn |
| `session.output` | `sessionId, data` | PTY stdout |
| `session.exited` | `sessionId, exitCode` | PTY process exited |
| `session.error` | `error` | Error message |

**Plain text, not base64.** The prior research doc specified base64 for `data` fields. This is unnecessary — xterm.js and bun-pty both deal in UTF-8 strings, and JSON.stringify handles control characters via `\uXXXX` escaping. Base64 would add ~33% bandwidth overhead for no benefit.

```typescript
// Client messages
type SessionCreateMsg = { type: "session.create"; cols: number; rows: number; cwd?: string };
type SessionInputMsg = { type: "session.input"; sessionId: string; data: string };
type SessionResizeMsg = { type: "session.resize"; sessionId: string; cols: number; rows: number };
type SessionDestroyMsg = { type: "session.destroy"; sessionId: string };
export type ClientMessage = SessionCreateMsg | SessionInputMsg | SessionResizeMsg | SessionDestroyMsg;

// Server messages
type SessionCreatedMsg = { type: "session.created"; sessionId: string };
type SessionOutputMsg = { type: "session.output"; sessionId: string; data: string };
type SessionExitedMsg = { type: "session.exited"; sessionId: string; exitCode: number };
type SessionErrorMsg = { type: "session.error"; error: string };
export type ServerMessage = SessionCreatedMsg | SessionOutputMsg | SessionExitedMsg | SessionErrorMsg;
```

## `pty-manager.ts` — PTY Lifecycle

Stateful module managing a `Map<string, Session>`. Does **not** know about WebSockets — accepts callbacks for output and exit events, keeping it decoupled and testable.

```typescript
interface CreateSessionOptions {
  cols: number;
  rows: number;
  cwd?: string;
  onOutput: (sessionId: string, data: string) => void;
  onExit: (sessionId: string, exitCode: number) => void;
}
```

**Exported functions:**

| Function | Behavior |
|----------|----------|
| `createSession(opts)` → `string` | Spawns PTY via `pty.spawn(process.env.SHELL \|\| "bash", [], { name: "xterm-256color", cols, rows, cwd: opts.cwd \|\| process.env.HOME, env: process.env })`. Returns `sessionId` (crypto.randomUUID). Wires `onData` → `opts.onOutput`, `onExit` → `opts.onExit` + auto-removes from map. Throws on spawn failure. |
| `writeToSession(id, data)` | Writes to PTY stdin. Throws if session not found. |
| `resizeSession(id, cols, rows)` | Calls `pty.resize()`. Throws if session not found. |
| `destroySession(id)` | Kills PTY, removes from map. **Idempotent** — no-op if already gone (important for cleanup races). |

## `index.ts` — WsHandler

Bridges WebSocket connections to the PTY manager. Maintains two maps for the bidirectional WS ↔ session relationship:

```typescript
const wsToSession = new Map<ServerWebSocket<WsData>, string>();
const sessionToWs = new Map<string, ServerWebSocket<WsData>>();
```

**Behavior:**

| Event | Action |
|-------|--------|
| `open(ws)` | No-op. No PTY allocated until client sends `session.create`. |
| `message(ws, "session.create")` | If WS already has a session → error. Otherwise call `createSession()` with callbacks that route `session.output` and `session.exited` back through this WS. Update both maps. Send `session.created`. |
| `message(ws, "session.input")` | Validate `sessionId` matches this WS's session → `writeToSession()`. |
| `message(ws, "session.resize")` | Validate → `resizeSession()`. |
| `message(ws, "session.destroy")` | `destroySession()`, clean both maps. Idempotent. |
| `close(ws)` | Kill associated PTY via `destroySession()`, clean maps. Prevents orphaned shell processes. |
| Invalid JSON / unknown type | Send `session.error`. |

**Import paths:**
- `WsHandler` and `WsData` from the server via relative path (`../../../server/src/plugins`) — within the server tsconfig compilation scope
- `ClientMessage` and `ServerMessage` from `../shared/protocol` (or `@plugins/terminal/shared/protocol`)

## Changes to Existing Files

**`web/tsconfig.app.json`** — Add `"../plugins/*/shared"` to `include` array.

**`server/tsconfig.json`** — Add `"../plugins/*/shared"` to `include` array.

**`server/src/plugins.ts`** — Add import and route entry:
```typescript
import { wsHandler as terminalWs } from "@plugins/terminal/server";

export const wsRoutes: Record<string, WsHandler> = {
  "/ws/terminal": terminalWs,
};
```

**`server/package.json`** — Add `bun-pty`:
```json
"dependencies": {
  "bun-pty": "^1.0.0"
}
```

Then `cd server && bun install`.

## Error Handling & Cleanup

| Scenario | Outcome |
|----------|---------|
| Browser tab closes / network drops | `close()` fires → PTY killed, maps cleaned |
| PTY exits (`exit` command) | `onExit` fires → `session.exited` sent, maps cleaned, WS stays open |
| `pty.spawn` fails (bad cwd, bad shell) | Caught in handler → `session.error` sent, no maps polluted |
| Invalid JSON from client | Caught → `session.error` sent |
| Double `session.create` on same WS | Rejected with `session.error` |
| `session.input` with wrong `sessionId` | Rejected with `session.error` |

## Implementation Sequence

1. Add `bun-pty` to `server/package.json`, run `bun install`
2. Add `"../plugins/*/shared"` to `include` in both `web/tsconfig.app.json` and `server/tsconfig.json`
3. Create `plugins/terminal/shared/protocol.ts`
4. Create `plugins/terminal/server/pty-manager.ts`
5. Create `plugins/terminal/server/index.ts`
6. Wire into `server/src/plugins.ts`

## Verification

```sh
cd server && bun dev
```

1. Server starts without errors, logs "listening on 9001"
2. Connect with wscat: `wscat -c ws://localhost:9001/ws/terminal`
3. Send `{"type":"session.create","cols":80,"rows":24}` → receive `{"type":"session.created","sessionId":"..."}`
4. Send `{"type":"session.input","sessionId":"...","data":"echo hello\r"}` → receive `session.output` messages with shell output
5. Send `{"type":"session.resize","sessionId":"...","cols":120,"rows":40}` → no error
6. Send `{"type":"session.destroy","sessionId":"..."}` → PTY killed
7. Disconnect → PTY cleaned up (verify no orphaned processes)
8. `cd web && bun run build` still compiles (no type errors introduced)

## Known Limitations (v0)

- **No session persistence** — PTY dies when WS disconnects. Server-side buffering is a separate future design.
- **No output throttling** — `yes` or `cat /dev/urandom` could cause memory growth. Future: check `ws.getBufferedAmount()` and pause PTY.
- **Full env inheritance** — PTY gets the server's `process.env`. Fine for local dev; needs sanitization for multi-tenant.
- **bun-pty** — Used instead of node-pty because node-pty's N-API addon fails with `posix_spawnp` under Bun. bun-pty uses Bun-native FFI and works reliably. API is nearly identical.
