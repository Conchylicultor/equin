# Terminal Plugin

## Context

equin needs a terminal panel so users can interact with shells (and eventually agent worktrees). This is the first plugin with a backend component, so the design also establishes the **server-side plugin pattern** — a shared Bun server at `server/` where plugins register WebSocket/HTTP handlers, mirroring the frontend's slot/contribution model.

The Go backend plan in CLAUDE.md is superseded — TypeScript/Bun is the backend language.

## Architecture Overview

```
Browser (xterm.js)  ──WebSocket──▶  Bun server (port 9001)  ──node-pty──▶  Shell process
```

- **Frontend:** xterm.js terminal emulator contributed to `Shell.Main`
- **Backend:** Bun server with plugin registration; terminal plugin manages PTY sessions via node-pty
- **Transport:** WebSocket at `/ws/terminal`, JSON messages

## File Structure

```
server/                              # NEW — shared backend server
├── package.json                     # @singularity/server, deps: node-pty
├── tsconfig.json
└── src/
    ├── index.ts                     # Bun.serve entry, loads plugin servers
    ├── types.ts                     # ServerPluginSetup, ServerContext
    └── plugins.ts                   # Server plugin registry (static imports)

plugins/terminal/
├── server/                          # NEW — terminal backend
│   ├── index.ts                     # ServerPluginSetup: registers /ws/terminal
│   ├── pty-manager.ts               # PTY lifecycle: create, write, resize, destroy
│   └── protocol.ts                  # Message types (imported by frontend too)
└── web/                             # NEW — terminal frontend
    ├── index.ts                     # PluginDefinition → Shell.Main
    ├── components/
    │   └── terminal-panel.tsx       # xterm.js + WebSocket glue
    └── hooks/
        └── use-terminal.ts          # WebSocket + xterm lifecycle hook
```

## Server Plugin Pattern

Each backend plugin exports a `ServerPluginSetup`. The shared server calls `setup(ctx)` at startup.

```typescript
// server/src/types.ts
export interface ServerPluginSetup {
  id: string;
  setup(ctx: ServerContext): void;
}

export interface ServerContext {
  addWebSocketHandler(path: string, handler: WebSocketHandler): void;
  addRoute(method: string, path: string, handler: RouteHandler): void;
}
```

```typescript
// server/src/plugins.ts
import terminalPlugin from "@plugins/terminal/server";
export const serverPlugins: ServerPluginSetup[] = [terminalPlugin];
```

The server entry (`server/src/index.ts`) uses `Bun.serve()` with native WebSocket support. It routes incoming WS upgrades and HTTP requests to the handlers registered by plugins.

## WebSocket Protocol

All messages are JSON with a `type` discriminator.

**Client → Server:**

| type | fields | purpose |
|------|--------|---------|
| `session.create` | `cols, rows` | Spawn a new PTY |
| `session.input` | `sessionId, data` | Keystrokes → PTY stdin |
| `session.resize` | `sessionId, cols, rows` | Resize PTY |
| `session.destroy` | `sessionId` | Kill PTY |

**Server → Client:**

| type | fields | purpose |
|------|--------|---------|
| `session.created` | `sessionId` | Confirms spawn |
| `session.output` | `sessionId, data` | PTY stdout (base64) |
| `session.exited` | `sessionId, exitCode` | PTY process exited |
| `session.error` | `error` | Error message |

One WebSocket connection per terminal instance. Protocol types live in `plugins/terminal/server/protocol.ts` and are imported by the frontend (types only, no runtime server code).

## PTY Manager

`plugins/terminal/server/pty-manager.ts` — stateful map of sessions:

- `createSession(cols, rows)` → spawns `node-pty` with `process.env.SHELL || "bash"`, returns `sessionId` (crypto.randomUUID)
- `writeToSession(id, data)` → decodes base64, writes to PTY stdin
- `resizeSession(id, cols, rows)` → calls `pty.resize()`
- `destroySession(id)` → kills PTY, removes from map
- PTY `onData` callback pushes `session.output` back through the WebSocket

## Frontend Components

**`plugins/terminal/web/index.ts`** — standard plugin definition:
```typescript
contributions: [
  Shell.Main({ title: "Terminal", component: TerminalPanel }),
]
```

**`terminal-panel.tsx`** — renders a full-height div, delegates to `useTerminal` hook.

**`use-terminal.ts`** — manages lifecycle:
1. Mount: open WebSocket to `/ws/terminal`, send `session.create`
2. Wire `terminal.onData` → `session.input` messages
3. Wire `session.output` messages → `terminal.write()`
4. ResizeObserver + FitAddon → `session.resize` messages
5. Unmount: `session.destroy`, close WebSocket, dispose terminal

xterm.js CSS imported directly: `import "@xterm/xterm/css/xterm.css"`.

## Dev Workflow

Two processes:
1. `cd server && bun dev` — Bun server with `--watch` on port 9001
2. `cd web && bun dev` — Vite on port 5173, proxies to backend

**Vite proxy** (add to `web/vite.config.ts`):
```typescript
server: {
  proxy: {
    "/ws": { target: "ws://localhost:9001", ws: true },
    "/api": { target: "http://localhost:9001" },
  },
}
```

## Dependencies

**server/package.json:** `node-pty`, `@types/bun`, `typescript`
**web/package.json:** add `@xterm/xterm`, `@xterm/addon-fit`

`node-pty` is a native N-API addon. Bun supports N-API. If compatibility issues arise, `bun-pty` (Bun-native FFI) is the fallback.

## Production

- Frontend: `cd web && bun run build` → `dist/`
- Backend: `cd server && bun src/index.ts` (Bun runs TS directly, no build step)
- The backend can optionally serve `web/dist/` static files for single-process production deploy
- Port 9000 serves the app (static + WS/API), or a reverse proxy fronts both

## Implementation Sequence

1. **Server infrastructure** — `server/` package.json, tsconfig, types.ts, index.ts, plugins.ts. Get Bun.serve running on 9001 accepting WebSocket connections.
2. **Terminal server plugin** — `plugins/terminal/server/` protocol.ts, pty-manager.ts, index.ts. Verify PTY spawning.
3. **Vite proxy** — update `web/vite.config.ts`.
4. **Terminal frontend plugin** — install xterm deps, create `plugins/terminal/web/` with component and hook.
5. **Register plugin** — add to `web/src/plugins.ts`.
6. **Update CLAUDE.md** — reflect TS backend, remove Go references for server/.

## Verification

1. `cd server && bun dev` starts without errors, logs "listening on 9001"
2. `cd web && bun dev` starts, terminal panel appears in main area
3. Typing in the terminal executes commands in a real shell
4. Resizing the browser window resizes the terminal
5. Closing the tab / navigating away kills the PTY session
6. `cd web && bun run build` completes without type errors
