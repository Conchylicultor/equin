# Extract non-framework primitives out of `plugin-core/` into `plugins/primitives/`

## Context

`plugin-core/` was created to hold the **framework**: slots, commands, contributions, plugin context, error boundaries, and the `PluginDefinition` type. Over time it has accreted things that are *not* framework — they are utilities that plugins consume, but they have nothing to do with the slot/contribution machinery:

- **Live-state**: `useResource` (TanStack Query bridge), `NotificationsProvider`, `NotificationsClient`, `queryKeyFor`, `ResourceDescriptor`, `resourceDescriptor`, `ResourceKey`.
- **Networking**: `useReconnectingWebSocket`, `ReconnectingEventSource`, `SharedWebSocket`, `fetchWithRetry`, `ws-status-bus` (`publishWsStatus`, `subscribeWsStatus`).
- **Editable field**: `useEditableField` and its types (just landed on this branch — `2026-04-27-plugin-core-use-editable-field.md`).

These should live as plugins, not in the framework. Two reasons:

1. **Framework purity**: `plugin-core/CLAUDE.md` advertises `plugin-core/` as "Framework primitives (slots, contributions)". Live-state and networking are domain primitives plugins *consume*, not extension-point machinery.
2. **Discoverability**: putting them under `plugins/` makes them appear in `docs/plugins.md` with their public APIs, contributors, and dependents — the same generated documentation surface every other plugin uses.

The umbrella `plugins/primitives/` groups these "infra-but-not-framework" plugins so they cluster together in the file tree and in `docs/plugins.md`, instead of being lost flat among feature plugins (the user's discoverability concern).

After this refactor:
- `plugin-core/` shrinks to 5 files: `types.ts`, `slots.ts`, `commands.ts`, `context.tsx`, `error-boundary.tsx`, plus its `index.ts` barrel.
- 9 files (and `shared/resource.ts`) move to `plugins/primitives/plugins/{live-state,networking,editable-field}/`.
- 124 import sites update from `@core` / `@core/shared/resource` to the appropriate sub-plugin barrel.
- Server is untouched (it has zero `@core` imports today, verified).

## Design

### Final layout

```
plugin-core/                                 # Framework only
├── types.ts                                 # PluginDefinition, PluginId, Contribution
├── slots.ts                                 # defineSlot, Slot, Core
├── commands.ts                              # defineCommand
├── context.tsx                              # PluginProvider, PluginRuntimeContext
├── error-boundary.tsx                       # PluginErrorBoundary, registerBoundaryReporter
├── index.ts                                 # Barrel — only the 5 files above
├── package.json                             # unchanged
└── CLAUDE.md                                # stripped of useResource / networking sections

plugins/primitives/
├── package.json                             # @singularity/plugin-primitives
├── web/index.ts                             # contributions: [] umbrella; no re-exports
└── plugins/
    ├── live-state/
    │   ├── package.json                     # @singularity/plugin-live-state
    │   ├── web/
    │   │   ├── index.ts                     # named re-exports + default PluginDefinition (contributions: [])
    │   │   ├── use-resource.ts              # moved verbatim
    │   │   └── notifications-client.ts      # moved verbatim
    │   └── shared/
    │       ├── index.ts                     # barrel: re-exports from ./resource
    │       └── resource.ts                  # moved from plugin-core/shared/resource.ts
    ├── networking/
    │   ├── package.json                     # @singularity/plugin-networking
    │   └── web/
    │       ├── index.ts                     # named re-exports + default PluginDefinition (contributions: [])
    │       ├── use-reconnecting-ws.ts       # moved verbatim
    │       ├── reconnecting-event-source.ts # moved verbatim
    │       ├── shared-websocket.ts          # moved verbatim
    │       ├── fetch-with-retry.ts          # moved verbatim
    │       └── ws-status-bus.ts             # moved verbatim — see "ws-status-bus placement"
    └── editable-field/
        ├── package.json                     # @singularity/plugin-editable-field
        └── web/
            ├── index.ts                     # named re-exports + default PluginDefinition (contributions: [])
            └── use-editable-field.ts        # moved verbatim
```

### What each plugin's barrel exports

**`plugins/primitives/plugins/live-state/web/index.ts`**
```ts
import type { PluginDefinition } from "@core";

export { NotificationsProvider, useResource } from "./use-resource";
export { NotificationsClient, queryKeyFor } from "./notifications-client";
export type { ResourceKey } from "./notifications-client";
// ResourceDescriptor + resourceDescriptor re-exported here for web consumers
// (the canonical source is ../shared/resource.ts so server-only plugin shared/
// folders can import them too).
export { resourceDescriptor } from "../shared/resource";
export type { ResourceDescriptor } from "../shared/resource";

export default {
  id: "live-state",
  name: "Live State",
  description:
    "Server live-state primitive: useResource hook + NotificationsProvider + NotificationsClient. Thin TanStack Query wrapper over the app's leader-elected /ws/notifications channel.",
  contributions: [],
} satisfies PluginDefinition;
```

**`plugins/primitives/plugins/live-state/shared/index.ts`**
```ts
export { resourceDescriptor } from "./resource";
export type { ResourceDescriptor } from "./resource";
```
Plugin `shared/resources.ts` files (7 sites) import from `@plugins/primitives/plugins/live-state/shared`. The shared barrel exists so server code paths reach `resourceDescriptor` through a `shared/` runtime, never `web/`.

**`plugins/primitives/plugins/networking/web/index.ts`**
```ts
import type { PluginDefinition } from "@core";

export { useReconnectingWebSocket } from "./use-reconnecting-ws";
export type { ReconnectingWsOptions, ReconnectingWsHandle } from "./use-reconnecting-ws";
export { ReconnectingEventSource } from "./reconnecting-event-source";
export type { ReconnectingEventSourceOptions } from "./reconnecting-event-source";
export { SharedWebSocket } from "./shared-websocket";
export { fetchWithRetry } from "./fetch-with-retry";
export type { FetchWithRetryOptions } from "./fetch-with-retry";
export { publishWsStatus, subscribeWsStatus } from "./ws-status-bus";
export type { WsStatus, WsStatusEvent } from "./ws-status-bus";

export default {
  id: "networking",
  name: "Networking",
  description:
    "WebSocket / EventSource / fetch primitives with reconnection, status-bus, and retry. Used by live-state internally and by terminal/logs/health/stats directly.",
  contributions: [],
} satisfies PluginDefinition;
```

**`plugins/primitives/plugins/editable-field/web/index.ts`**
```ts
import type { PluginDefinition } from "@core";

export { useEditableField } from "./use-editable-field";
export type { EditableField, UseEditableFieldOptions } from "./use-editable-field";

export default {
  id: "editable-field",
  name: "Editable Field",
  description:
    "Debounced-autosave field hook with focus tracking, flush-on-blur, and self-echo suppression. Used by task/agent detail forms.",
  contributions: [],
} satisfies PluginDefinition;
```

**`plugins/primitives/web/index.ts`** (umbrella, exists only so docgen nests sub-plugins under "primitives"):
```ts
import type { PluginDefinition } from "@core";

export default {
  id: "primitives",
  name: "Primitives",
  description:
    "Umbrella for cross-cutting client-side primitives used by feature plugins: live state, networking, editable fields.",
  contributions: [],
} satisfies PluginDefinition;
```

The umbrella does **not** re-export children's APIs. Consumers import directly from each sub-plugin's barrel — same convention `conversations/web/index.ts` follows (it re-exports its *own* helpers, not `conversations/plugins/conversation-view/web`'s).

### `ws-status-bus` placement: inside `networking`

The bus has three users today:

| File | Action | Verified by |
|---|---|---|
| `plugin-core/shared-websocket.ts` | publishes | imports `publishWsStatus` |
| `plugin-core/use-reconnecting-ws.ts` | publishes | imports `publishWsStatus` |
| `plugin-core/reconnecting-event-source.ts` | publishes | imports `publishWsStatus` |
| `plugin-core/notifications-client.ts` | publishes (via `SharedWebSocket`) | indirect |
| `plugins/health/web/...` | subscribes | imports `subscribeWsStatus` |

All four publishers are networking primitives. The one external consumer (health) treats the bus as "are my WebSockets/EventSources connected?" — also a networking concern.

`NotificationsClient` (live-state) reaches the bus *through* `SharedWebSocket` (networking). After the move, `live-state/notifications-client.ts` imports `SharedWebSocket` and `publishWsStatus` from `@plugins/primitives/plugins/networking/web`. This creates one cross-plugin edge: `live-state → networking`. That edge is acyclic and matches the dependency direction (live-state is built on networking, not the reverse).

Alternative considered: a fourth sub-plugin `connection-status` owning just the bus. Rejected — adds a plugin for one ~30-line file, with no semantic gain (the bus *is* networking status).

### Why no parent-barrel re-exports

Looking at existing umbrellas:

- `plugins/conversations/web/index.ts` re-exports its own `useConversation` helpers (named re-exports of files at the same level). It does **not** re-export from `plugins/conversations/plugins/conversation-view/web`. Children own their own surface.
- `plugins/stats/web/index.ts` exports `Stats` (the slot it defines) and `statsPane`. Children (`commits`, `tasks`) are imported directly when needed.

Mirroring this convention, `plugins/primitives/web/index.ts` is empty. Consumers `import { useResource } from "@plugins/primitives/plugins/live-state/web"` rather than `from "@plugins/primitives/web"`. Slightly more verbose — but explicit about which sub-plugin a file depends on, and matches every other umbrella in the codebase.

## Critical files

| File | Change |
|---|---|
| `plugin-core/index.ts` | Strip down to lines 1–10 (the framework exports). Delete lines 11–29 (use-reconnecting-ws, reconnecting-event-source, shared-websocket, fetch-with-retry, ws-status-bus, use-resource, notifications-client, use-editable-field). |
| `plugin-core/use-resource.ts`, `notifications-client.ts`, `use-reconnecting-ws.ts`, `reconnecting-event-source.ts`, `shared-websocket.ts`, `fetch-with-retry.ts`, `ws-status-bus.ts`, `use-editable-field.ts` | **Move** to the sub-plugin paths in the layout above (verbatim — no code change in the moved files themselves). |
| `plugin-core/shared/resource.ts` | **Move** to `plugins/primitives/plugins/live-state/shared/resource.ts`. Delete `plugin-core/shared/` afterward. |
| `plugin-core/CLAUDE.md` | Strip the "Live state — `useResource`" section and the `ReconnectingEventSource` mention. Replace with a one-line "For live state and networking primitives, see `plugins/primitives/`." Update File Structure tree. |
| `plugins/primitives/web/index.ts`, `package.json` | **New.** Empty PluginDefinition + standard package.json. |
| `plugins/primitives/plugins/live-state/{web,shared}/index.ts`, `package.json` | **New.** As specified above. |
| `plugins/primitives/plugins/networking/web/index.ts`, `package.json` | **New.** As specified above. |
| `plugins/primitives/plugins/editable-field/web/index.ts`, `package.json` | **New.** As specified above. |
| `plugins/primitives/plugins/live-state/web/notifications-client.ts` | After move, update the internal `import { SharedWebSocket } from "./shared-websocket"` and `import { publishWsStatus } from "./ws-status-bus"` lines to `@plugins/primitives/plugins/networking/web` (these are the only intra-source edits to moved files — everything else is rename-only). |
| `web/src/plugins.ts` | Add 4 imports + 4 entries in the array (umbrella + 3 children). |
| **124 consumer import sites** | Mechanical rewrite — see "Migration mechanics". |

## Migration mechanics

The 124 `@core` imports break into two categories:

**Framework-only (~80 sites)** — files that import only `PluginDefinition`, `defineSlot`, `defineCommand`, `Core`, `PluginErrorBoundary`, `PluginProvider`, etc. **These do not change.** `@core` continues to export the framework surface.

**Non-framework (~44 sites)** — split by destination:

| Old import | New import | Sites |
|---|---|---|
| `useResource` from `@core` | `@plugins/primitives/plugins/live-state/web` | 31 |
| `ResourceDescriptor`, `resourceDescriptor` from `@core` (web) | `@plugins/primitives/plugins/live-state/web` | ~4 web + ~2 web mixed |
| `resourceDescriptor` from `@core/shared/resource` (plugin shared/) | `@plugins/primitives/plugins/live-state/shared` | 7 |
| `NotificationsProvider` from `@core` | `@plugins/primitives/plugins/live-state/web` | 1 (`web/src/App.tsx`) |
| `useReconnectingWebSocket`, `ReconnectingWsOptions`, `ReconnectingWsHandle` | `@plugins/primitives/plugins/networking/web` | 2 |
| `ReconnectingEventSource`, `ReconnectingEventSourceOptions` | `@plugins/primitives/plugins/networking/web` | 2 |
| `fetchWithRetry`, `FetchWithRetryOptions` | `@plugins/primitives/plugins/networking/web` | 2 |
| `subscribeWsStatus`, `WsStatus`, `WsStatusEvent` | `@plugins/primitives/plugins/networking/web` | 1 (health) |
| `useEditableField`, `EditableField`, `UseEditableFieldOptions` | `@plugins/primitives/plugins/editable-field/web` | 2 |

When a single `import { ... } from "@core"` line mixes framework imports (e.g. `PluginDefinition`) with non-framework imports (e.g. `useResource`), split it into two lines: the framework import keeps `@core`, the non-framework names move to the sub-plugin barrel.

Mechanical, file-by-file. No semantic edits in the moved files except the two intra-source edges in `notifications-client.ts` mentioned above.

### Boundary linter expectations

After the refactor, `./equin check --plugin-boundaries` must pass. Three rules to verify:

- **R3 (barrel purity)**: every new `index.ts` is imports + named re-exports + a single `export default`. Verified by inspection — the bodies above conform.
- **R4 (grammar)**: cross-plugin imports terminate at `web` / `server` / `shared`. All consumer rewrites target `@plugins/primitives/plugins/{name}/{web|shared}` — valid barrels.
- **R5 (default-import)**: only `web/src/plugins.ts` and `server/src/plugins.ts` import default exports. Consumers do `import { useResource } from ...` (named), not `import liveStatePlugin from ...`. ✓
- **R6 (DAG)**: the only new edge is `live-state → networking` (one direction). Health, terminal, logs, stats already exist as nodes; new edges from them to `networking` are also acyclic.

The `no-plugin-imports-in-core` check forbids `plugin-core/` from importing `@plugins/*`. After the move, `plugin-core/` imports nothing from `@plugins/*` — it only owns the framework. ✓

The `plugins-doc-in-sync` check auto-discovers via filesystem walk (`cli/src/docgen.ts:findAllPluginDirs`). It will find the 4 new plugins automatically; the generated `docs/plugins.md` diff is the verification.

## Server-side: nothing changes

`rg -l '@core' server/src/ plugins/*/server/ plugins/**/server/` returns zero. Plugin `shared/resources.ts` files import `@core/shared/resource` and *are* pulled into server compilation — but those imports change to `@plugins/primitives/plugins/live-state/shared`, which is a `shared/` barrel and therefore valid for both runtimes. The server tsconfig's existing `@plugins/*` alias resolves it without any tsconfig change.

## Sequencing

The migration is one PR. Splitting buys nothing — every step requires the consumer rewrites in the same commit (otherwise type-check breaks), and the move is mechanical.

Order of operations within the PR:
1. Create the 4 new plugin folders with their `package.json` + `index.ts` files.
2. Move the 9 files (8 web + 1 shared) into the new paths. Update the 2 intra-source imports inside `notifications-client.ts`.
3. Update `plugin-core/index.ts` to drop the moved exports.
4. Update `plugin-core/CLAUDE.md`.
5. Rewrite the 44 non-framework consumer imports (`rg -l 'useResource\|useEditableField\|...'` + sed-style mechanical replace).
6. Add the 4 new plugins to `web/src/plugins.ts`.
7. `bun install` (workspace registers the new package.json files).
8. `./equin build` — type-checks, regenerates `docs/plugins.md`, restarts server.
9. `./equin check --plugin-boundaries` and `./equin check --plugins-doc-in-sync` — both must pass.

## Verification

1. **Type-check passes**: `./equin build` completes cleanly. The frontend builds with no `@core` resolution errors.
2. **Boundary linter clean**: `./equin check --plugin-boundaries` returns ok. (R4 grammar in particular: no consumer imports a deeper path than `/web` or `/shared`.)
3. **Docgen in sync**: `./equin check --plugins-doc-in-sync` passes — `docs/plugins.md` includes new entries for `primitives`, `primitives/plugins/live-state`, `primitives/plugins/networking`, `primitives/plugins/editable-field`, with their public exports listed.
4. **Live-state still works** (the highest-blast-radius surface): open `http://<worktree>.localhost:9000`, confirm tasks list, conversation list, attempts list, push counters all render and update reactively. These all flow through `useResource` — if the `NotificationsProvider`/`NotificationsClient` rewire is broken, they go stale.
5. **Networking still works**: open `Debug → Logs` (uses `useReconnectingWebSocket` + `ReconnectingEventSource` + `fetchWithRetry`), terminal pane (uses `useReconnectingWebSocket`). Each must connect and stream.
6. **Editable-field still works**: focus a task description, type, pause >500 ms — saves and stays in place (no caret jump). Repeat on agent name/description/prompt.
7. **Status bus still works**: kill the server (`./equin build` restart), confirm the health plugin's reconnect toast appears (it subscribes via `subscribeWsStatus`).
8. **No git noise in `plugin-core/`**: after the PR, `plugin-core/` contains exactly `types.ts`, `slots.ts`, `commands.ts`, `context.tsx`, `error-boundary.tsx`, `index.ts`, `package.json`, `CLAUDE.md`. `shared/` is gone.

Done when all 8 pass and the diff is dominated by `git mv` + import path rewrites (no surprise behavioral edits).
