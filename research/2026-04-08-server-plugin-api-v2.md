# Server Plugin API — v2 (No Framework)

## Context

equin's frontend plugin system (slots + contributions) solves a real composition problem: multiple plugins contribute UI fragments to a shared layout without knowing about each other. The shell doesn't know what's in the sidebar — it just renders whatever was contributed.

Does this pattern translate to the server? **No.** On the server, each plugin owns its URL paths entirely. There's no "multiple plugins contributing handlers to the same endpoint" scenario:

- Terminal plugin owns `/ws/terminal` — no other plugin extends it.
- Future tasks plugin owns `/api/tasks` — self-contained.
- Future agent plugin owns `/ws/agent` — same.

URL routing is already a natural extension mechanism. A `ServerContext` with `.route()` and `.ws()` is just a thin wrapper around two Maps — it doesn't enable composition the way slots do. It's an abstraction that doesn't pay for itself.

**Decision:** No server framework. The server is a plain Bun app that imports handlers from plugin folders. The "plugin API" is just a file convention.

## Why plugin-core/ stays frontend-only

Since the server has no primitives of its own (no slots, no contributions), there's nothing to put in `plugin-core/server/`. The shared contract between the server and plugins is just TypeScript imports. No library needed.

## Architecture

```
server/                          # Bun server — just an app, not a framework
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                 # Bun.serve entry — imports plugin handlers directly
    └── plugins.ts               # Collects all plugin routes into a single structure
```

Plugin server code lives in `plugins/{name}/server/` and exports whatever the server needs — handler functions, WebSocket handlers, etc. The server entry file imports them directly.

## Server Entry

```typescript
// server/src/index.ts

import { httpRoutes, wsRoutes } from "./plugins";

const server = Bun.serve({
  port: 9001,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (req.headers.get("upgrade") === "websocket") {
      const handler = wsRoutes[url.pathname];
      if (handler) {
        server.upgrade(req, { data: { path: url.pathname } });
        return;
      }
    }

    // HTTP routing
    const route = httpRoutes[`${req.method} ${url.pathname}`];
    if (route) return route(req);

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) { wsRoutes[ws.data.path]?.open(ws); },
    message(ws, msg) { wsRoutes[ws.data.path]?.message(ws, msg); },
    close(ws, code, reason) { wsRoutes[ws.data.path]?.close(ws, code, reason); },
  },
});

console.log(`Server listening on :${server.port}`);
```

## Plugin Registry

```typescript
// server/src/plugins.ts

import { wsHandler as terminalWs } from "@plugins/terminal/server";

// HTTP routes: "METHOD /path" → handler
export const httpRoutes: Record<string, (req: Request) => Response | Promise<Response>> = {
  // "GET /api/terminal/sessions": terminalSessions,
};

// WebSocket routes: "/path" → handler
export const wsRoutes: Record<string, WsHandler> = {
  "/ws/terminal": terminalWs,
};

// Shared WS handler shape (matches Bun.serve websocket option)
export interface WsHandler {
  open(ws: ServerWebSocket<{ path: string }>): void;
  message(ws: ServerWebSocket<{ path: string }>, msg: string | Buffer): void;
  close(ws: ServerWebSocket<{ path: string }>, code: number, reason: string): void;
}
```

That's it. Adding a new plugin's server routes = add an import + an entry in the record. Same as adding a frontend plugin to `web/src/plugins.ts`.

## What Plugins Export

Each plugin decides its own export shape. The only constraint is that WebSocket handlers match Bun's `{ open, message, close }` interface. Examples:

```typescript
// plugins/terminal/server/index.ts
export const wsHandler: WsHandler = { open, message, close };

// plugins/tasks/server/index.ts (hypothetical)
export function listTasks(req: Request): Response { ... }
export function createTask(req: Request): Response { ... }
```

No base class, no interface to implement, no `setup()` ceremony. Just exports.

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
      "@plugins/*": ["../plugins/*"]
    }
  },
  "include": ["src", "../plugins/*/server"]
}
```

## Dev Workflow

```sh
cd server && bun dev   # starts on :9001 with --watch
```

Vite proxy (add to `web/vite.config.ts`):
```typescript
server: {
  proxy: {
    "/ws": { target: "ws://localhost:9001", ws: true },
    "/api": { target: "http://localhost:9001" },
  },
}
```

## CLAUDE.md Updates

- `server/` description: "Backend (TypeScript/Bun)" — remove "(Go, future)"
- Plugin folder structure: add `server/` alongside `web/` for plugins that need a backend

## Verification

1. `cd server && bun install && bun dev` — logs "Server listening on :9001"
2. `curl http://localhost:9001/` — returns 404
3. WebSocket connections upgrade on registered paths
4. TypeScript compiles clean: `cd server && bunx tsc --noEmit`

## Implementation Sequence

1. Create `server/package.json` and `server/tsconfig.json`
2. Create `server/src/plugins.ts` — WsHandler type + empty route records
3. Create `server/src/index.ts` — Bun.serve with routing
4. Add Vite proxy to `web/vite.config.ts`
5. `cd server && bun install` and verify server starts
6. Update CLAUDE.md
