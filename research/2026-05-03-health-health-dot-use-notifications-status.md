# HealthDot: derive status from NotificationsClient, not the raw WS bus

## Context

The `HealthDot` toolbar indicator was showing "Disconnected" (red) even when the
server was fully healthy. Root cause: it subscribed to the global `ws-status-bus`
and accumulated every `"closed"` event in a `Map<url, WsStatus>` that never
removed entries. Opening and then closing a terminal pane publishes `"closed"` for
`/ws/terminal`, which permanently poisoned the Map — even though `"closed"` only
ever means intentional component teardown, never a real server outage.

A band-aid fix (treat `"closed"` as "delete from Map") works today only because of
an implicit invariant: `SharedWebSocket` never publishes `"closed"`, so every
`"closed"` entry is guaranteed to be from a feature socket. That invariant is
undocumented and fragile.

The structural issue: the `ws-status-bus` conflates two unrelated concerns —
**infrastructure health** (`/ws/notifications`, `/ws/central-notifications`) and
**feature component lifecycle** (`/ws/terminal`, `/ws/logs`). `HealthDot` is
reading the wrong layer.

The correct fix: `NotificationsClient` (live-state plugin) IS the server liveness
proxy — its two `SharedWebSocket` channels are the infrastructure connections.
`HealthDot` should derive its status from `NotificationsClient` via React context,
completely decoupled from the raw bus.

## Plan

### Step 1 — `NotificationsClient` tracks aggregate channel status

**File:** `plugins/primitives/plugins/live-state/web/notifications-client.ts`

- Import `subscribeWsStatus` and `WsStatus` from `@plugins/primitives/plugins/networking/web`.
- Add private fields:
  ```ts
  private channelStatuses = new Map<string, WsStatus>();   // url → status
  private statusListeners = new Set<(s: WsStatus) => void>();
  ```
- In the constructor, subscribe to `ws-status-bus` filtering on the two owned URLs
  (`WS_URLS.worktree` and `WS_URLS.central`). Store the unsubscribe fn and call it
  in a new `destroy()` method (for completeness, not strictly needed since the client
  is a tab-lifetime singleton).
- Add `getStatus(): WsStatus` — reduces `channelStatuses` with priority:
  `reconnecting` > `closed` > `connecting` > `open`; returns `"connecting"` when
  the map is empty (initial state before first event).
- Add `subscribeStatus(fn: (s: WsStatus) => void): () => void` — standard
  add/delete listener pattern; calls `fn` with `getStatus()` immediately on
  subscribe so callers get the current state without waiting for the next transition.

### Step 2 — `useNotificationsStatus()` hook in live-state

**File:** `plugins/primitives/plugins/live-state/web/use-resource.ts`

Add after the existing `useResource` hook:

```ts
export function useNotificationsStatus(): WsStatus {
  const client = useContext(NotificationsContext);
  if (!client) throw new Error("useNotificationsStatus must be inside NotificationsProvider");
  const [status, setStatus] = useState(() => client.getStatus());
  useEffect(() => client.subscribeStatus(setStatus), [client]);
  return status;
}
```

### Step 3 — Re-export from the live-state barrel

**File:** `plugins/primitives/plugins/live-state/web/index.ts`

Add `useNotificationsStatus` to the existing export line from `./use-resource`.

Also export the `WsStatus` type from networking via this barrel (re-export as a
type) so `HealthDot` doesn't need a direct networking import for just the type.

### Step 4 — Rewrite `HealthDot` to use `useNotificationsStatus`

**File:** `plugins/health/web/components/health-dot.tsx`

Replace the `subscribeWsStatus` / `Map` approach entirely:

```ts
import { useNotificationsStatus } from "@plugins/primitives/plugins/live-state/web";

export function HealthDot() {
  const status = useNotificationsStatus();
  const config = DOT_CONFIG[status];
  return (/* same JSX */);
}
```

- Remove the `computeOverall` function and the `Map<string, WsStatus>` state.
- `DOT_CONFIG` stays as-is; `"closed"` entry can remain even though `SharedWebSocket`
  never emits it (it's a valid type value and costs nothing to keep).
- Drop the `subscribeWsStatus` import from networking.
- Revert the stash band-aid fix that was applied earlier (the new approach supersedes it).

### Step 5 — No changes to `ReconnectWatcher`

`ReconnectWatcher` correctly subscribes to the raw bus across ALL connection URLs
to trigger the "Reconnected to server" toast whenever any previously-dropping
connection recovers. That behaviour is intentional and unaffected by this change.

## Files changed

| File | Change |
|---|---|
| `plugins/primitives/plugins/live-state/web/notifications-client.ts` | Add status tracking + `getStatus()` + `subscribeStatus()` |
| `plugins/primitives/plugins/live-state/web/use-resource.ts` | Add `useNotificationsStatus()` hook |
| `plugins/primitives/plugins/live-state/web/index.ts` | Re-export `useNotificationsStatus` |
| `plugins/health/web/components/health-dot.tsx` | Replace bus subscription with `useNotificationsStatus()` |

## Verification

1. `./equin build` — must pass all checks including `plugin-boundaries`.
2. Open the app at `http://att-1777822854-4hbk.localhost:9000`.
3. Health dot should be **green** immediately on load (no "connecting" flash).
4. Open a terminal pane, then close it — dot stays **green** (was: turns red).
5. Stop the backend manually; dot should turn **yellow** (reconnecting) while server
   is down, then return to **green** once it restarts.
