# Log Viewer

## Context

The build plugin already publishes output to `Log.channel("build")` via the logs plugin's in-memory channel system (`plugins/logs/server/api.ts`), but there's no way to view those logs in the UI. This plan adds:
- Server endpoints to list channels and stream log entries
- A frontend log viewer pane opened from the sidebar

## Server

### 1. Move registry to `plugins/logs/server/internal/registry.ts`

The `registry` Map and its types (`LogEntry`, `InternalChannel`) move from `api.ts` to `internal/registry.ts`. This module owns the in-memory state and exposes three functions:

- `createChannel(id: string): LogChannel` — same logic as current `Log.channel()`, used by `api.ts`
- `getChannelIds(): string[]` — returns `Array.from(registry.keys())`, used by http handler
- `subscribe(id: string, listener): { history: LogEntry[]; unsubscribe: () => void }` — used by ws handler

`api.ts` becomes a thin public re-export: `Log.channel()` delegates to `createChannel()`. This keeps `api.ts` as the public API for other plugins (like build) while the registry internals stay in `internal/`.

### 2. HTTP handler: `plugins/logs/server/internal/handle-channels.ts`

```
GET /api/logs/channels → { channels: string[] }
```

### 3. WebSocket handler: `plugins/logs/server/internal/ws-handler.ts`

Following the terminal plugin's pattern (`plugins/terminal/server/internal/ws-handler.ts`):

- **open** — no-op, wait for subscribe message
- **message** — parse `{ type: "subscribe", channel: string }`. Call `subscribe()`, send `{ type: "history", entries }` immediately, then stream `{ type: "entry", ...entry }` for each new entry. If already subscribed to a different channel, unsubscribe first (supports switching without reconnecting).
- **close** — call stored unsubscribe, clean up

### 4. Wire routes in `plugins/logs/server/index.ts`

Add `httpRoutes` and `wsRoutes` to the existing empty plugin definition. The logs plugin is already registered in `server/src/plugins.ts`.

## Shared Protocol: `plugins/logs/shared/protocol.ts`

```typescript
// Client → Server
type SubscribeMsg = { type: "subscribe"; channel: string };
type ClientMessage = SubscribeMsg;

// Server → Client
type HistoryMsg = { type: "history"; entries: LogEntryWire[] };
type EntryMsg = { type: "entry" } & LogEntryWire;
type ErrorMsg = { type: "error"; error: string };
type ServerMessage = HistoryMsg | EntryMsg | ErrorMsg;

interface LogEntryWire { line: string; stream: "stdout" | "stderr"; timestamp: number; }
```

## Frontend

### 5. Add shadcn Select component

Run `bunx shadcn@latest add select` from `web/` to generate `web/src/components/ui/select.tsx`.

### 6. Log viewer component: `plugins/logs/web/components/log-viewer.tsx`

Props: `{ initialChannel?: string }` (optional, for opening directly to a channel).

Behavior:
1. On mount: fetch `GET /api/logs/channels`, populate dropdown, select `initialChannel` or first available
2. On channel change: send `{ type: "subscribe", channel }` over WebSocket (single connection, reused across channel switches)
3. On `history` message: replace entries state
4. On `entry` message: append to entries state
5. Auto-scroll: track whether user is near bottom via IntersectionObserver on a sentinel div. Only auto-scroll when sentinel is visible.
6. Cleanup: close WebSocket on unmount

Rendering:
- Top: `<Select>` dropdown with channel options
- Below: monospace log area. Stderr lines styled with `text-destructive`, stdout with `text-foreground`

### 7. Plugin definition: `plugins/logs/web/index.ts`

Contribute to `Shell.Sidebar` with title "Logs", icon `MdSubject`. The sidebar component lists available channels (fetched from the API). Clicking a channel calls `Shell.OpenPane(logPane({ channel }))`.

### 8. View factory: `plugins/logs/web/views.tsx`

```typescript
export function logPane(args?: { channel?: string }): PaneDescriptor {
  return { title: "Logs", component: () => <LogViewer initialChannel={args?.channel} /> };
}
```

### 9. Register in `web/src/plugins.ts`

Add `logsPlugin` import and entry.

## Files

**New:**
| File | Purpose |
|------|---------|
| `plugins/logs/server/internal/registry.ts` | In-memory channel registry (moved from api.ts) |
| `plugins/logs/shared/protocol.ts` | WebSocket message types |
| `plugins/logs/server/internal/handle-channels.ts` | GET handler |
| `plugins/logs/server/internal/ws-handler.ts` | WS handler |
| `plugins/logs/web/index.ts` | Frontend plugin definition |
| `plugins/logs/web/views.tsx` | View factory |
| `plugins/logs/web/components/log-viewer.tsx` | Main component |

**Modified:**
| File | Change |
|------|--------|
| `plugins/logs/server/api.ts` | Thin wrapper — delegates to `internal/registry.ts` |
| `plugins/logs/server/index.ts` | Add routes |
| `web/src/plugins.ts` | Add logsPlugin |

## Verification

1. `./equin build` to deploy
2. `GET /api/logs/channels` returns `{ "channels": ["build"] }`
3. Open app — sidebar shows "Logs" with "build" channel entry
4. Click "build" — log viewer pane opens with channel dropdown
5. Trigger a build — logs stream in real time
6. Stderr lines appear in destructive/red color
7. Refresh page — history loads from rolling buffer
8. Scroll up during output — auto-scroll pauses; scroll back down — resumes
