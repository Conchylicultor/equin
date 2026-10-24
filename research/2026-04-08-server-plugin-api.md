# Server Plugin API

## Context

equin's frontend is built on a plugin system with two primitives: **slots** (typed extension points) and **contributions** (data provided to slots). Every feature is a plugin.

The server has no code yet. The terminal plugin needs a backend, and other plugins will too. This design establishes the **server-side plugin pattern** — a shared Bun server where plugins register handlers, mirroring the frontend's philosophy of minimal primitives and static registration.

The Go backend plan is superseded — TypeScript/Bun is the backend language.

## Design Principles

Matching the frontend:
- **Minimal primitives** — the frontend has two (slot, contribution). The server should be equally thin.
- **Static registration** — plugins are statically imported, known at startup. No dynamic loading.
- **Plugins never import each other's internals** — only shared interfaces.
- **No lifecycle complexity** — no DI, no hooks system, no middleware chains.

## Primitives

The server has **one primitive**: the **route**.

A route is a handler bound to a path. Two kinds:
- **HTTP route** — `method + path → handler`
- **WebSocket route** — `path → handler`

That's it. No slots abstraction on the server — the server's "extension points" are URL paths. A plugin owns its paths.

## Types

```typescript
// server/src/types.ts

export interface ServerPlugin {
  id: string;
  name: string;
  setup(ctx: ServerContext): void;
}

export interface ServerContext {
  /** Register an HTTP route */
  route(method: string, path: string, handler: HttpHandler): void;

  /** Register a WebSocket handler for a path */
  ws(path: string, handler: WsHandler): void;
}

export type HttpHandler = (req: Request) => Response | Promise<Response>;

export interface WsHandler {
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, msg: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>, code: number, reason: string): void;
}

export interface WsData {
  path: string;
}
```

`ServerWebSocket` and related types come from Bun's built-in types — no external WS library needed.

## Server Bootstrap

```typescript
// server/src/index.ts

import { serverPlugins } from "./plugins";
import type { ServerContext, HttpHandler, WsHandler, WsData } from "./types";

const httpRoutes = new Map<string, HttpHandler>();     // "GET /api/health" → handler
const wsRoutes = new Map<string, WsHandler>();          // "/ws/terminal" → handler

const ctx: ServerContext = {
  route(method, path, handler) {
    httpRoutes.set(`${method.toUpperCase()} ${path}`, handler);
  },
  ws(path, handler) {
    wsRoutes.set(path, handler);
  },
};

// Load all plugins
for (const plugin of serverPlugins) {
  plugin.setup(ctx);
}

const server = Bun.serve<WsData>({
  port: 9001,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    const wsHandler = wsRoutes.get(url.pathname);
    if (wsHandler && req.headers.get("upgrade") === "websocket") {
      server.upgrade(req, { data: { path: url.pathname } });
      return;
    }

    // HTTP routing
    const key = `${req.method} ${url.pathname}`;
    const handler = httpRoutes.get(key);
    if (handler) return handler(req);

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsRoutes.get(ws.data.path)?.open(ws);
    },
    message(ws, msg) {
      wsRoutes.get(ws.data.path)?.message(ws, msg);
    },
    close(ws, code, reason) {
      wsRoutes.get(ws.data.path)?.close(ws, code, reason);
    },
  },
});

console.log(`Server listening on :${server.port}`);
```

This is ~40 lines. The entire server framework.

## Plugin Registry

```typescript
// server/src/plugins.ts

import type { ServerPlugin } from "./types";

// Static imports, just like web/src/plugins.ts
export const serverPlugins: ServerPlugin[] = [
  // terminalPlugin will go here
];
```

## Example Plugin Usage

```typescript
// plugins/terminal/server/index.ts

import type { ServerPlugin } from "@server/types";

const terminalPlugin: ServerPlugin = {
  id: "terminal",
  name: "Terminal",
  setup(ctx) {
    ctx.ws("/ws/terminal", {
      open(ws)    { /* create PTY session */ },
      message(ws, msg) { /* route to PTY */ },
      close(ws)   { /* destroy PTY session */ },
    });

    // Optional: REST endpoint for listing sessions
    ctx.route("GET", "/api/terminal/sessions", (req) => {
      return Response.json([]);
    });
  },
};

export default terminalPlugin;
```

## File Structure

```
server/                          # NEW — shared backend
├── package.json                 # @singularity/server
├── tsconfig.json
└── src/
    ├── index.ts                 # Bun.serve bootstrap (~40 lines)
    ├── types.ts                 # ServerPlugin, ServerContext, handlers
    └── plugins.ts               # Static plugin registry
```

Three source files. That's the entire framework.

## Package Configuration

```jsonc
// server/package.json
{
  "name": "@singularity/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "~5.8.3"
  }
}
```

No runtime dependencies for the server framework itself. Plugins bring their own deps (e.g., terminal plugin adds `node-pty`).

```jsonc
// server/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["bun-types"],
    "baseUrl": ".",
    "paths": {
      "@server/*": ["./src/*"],
      "@plugins/*": ["../plugins/*"]
    }
  },
  "include": ["src", "../plugins/*/server"]
}
```

Mirrors the frontend's tsconfig pattern: `@plugins/*` alias and includes `../plugins/*/server`.

## Dev Workflow

```sh
cd server && bun dev   # starts on :9001 with --watch
```

Vite proxy config (added to `web/vite.config.ts`):
```typescript
server: {
  proxy: {
    "/ws": { target: "ws://localhost:9001", ws: true },
    "/api": { target: "http://localhost:9001" },
  },
}
```

## What This Design Does NOT Do

- **No slots on the server** — URL paths are the natural extension points. No need to reinvent routing.
- **No inter-plugin communication** — same as frontend, deferred until concrete use cases arise.
- **No middleware** — plugins own their paths entirely. Shared concerns (auth, logging) can be added later as wrapper utilities, not framework features.
- **No plugin lifecycle hooks** (init, destroy, health) — `setup()` runs once at startup. Cleanup on `process.on("SIGTERM")` is the plugin's own responsibility if needed.
- **No dynamic route matching** (`:id` params, wildcards) — exact path match only. Plugins parse their own sub-paths from the URL if needed.

## CLAUDE.md Updates

Update the folder structure and server description:
- `server/` — Backend (TypeScript/Bun, shared server with plugin registration)
- Remove Go references for server/

## Verification

1. `cd server && bun install && bun dev` — logs "Server listening on :9001"
2. `curl http://localhost:9001/` — returns 404 "Not found" (no routes registered)
3. Add a test route in plugins.ts, verify it responds
4. WebSocket upgrade works on registered paths
5. `bun tsc --noEmit` in server/ passes

## Implementation Sequence

1. Create `server/package.json` and `server/tsconfig.json`
2. Create `server/src/types.ts` — ServerPlugin, ServerContext, handler types
3. Create `server/src/plugins.ts` — empty registry
4. Create `server/src/index.ts` — Bun.serve bootstrap
5. Add Vite proxy to `web/vite.config.ts`
6. `bun install` and verify server starts
7. Update CLAUDE.md
