# App-Scoped Pane Routing

## Context

Clicking sidebar items in the debug app navigates to the agent-manager instead of staying in the debug app. Three panes have segments missing the `debug/` prefix (`logs`, `events-test`, `recovery`), so their URLs (`/logs`, `/events-test`, `/recovery`) fall outside `/debug/...` and the agent-manager (catch-all `/`) takes over.

The deeper issue: panes must manually include the app prefix in their segment (`segment: "debug/queue"`). No structural mechanism scopes pane URLs to their app. The fix makes the pane system app-aware: apps provide a `basePath` that the pane system strips on read and prepends on write — pane segments stay app-local.

## Design: App-aware basePath

The active app's path (e.g. `/debug`) becomes an implicit URL prefix layer managed by the pane system. Panes define local segments (`"queue"`, not `"debug/queue"`). The framework handles the prefix.

```
Before:  Pane.define({ segment: "debug/queue", ... })   // manual prefix, easy to forget
After:   Pane.define({ segment: "queue", ... })          // app-local, basePath handles the rest
```

### How it works

Two choke points in the pane system handle all URL read/write:

- **Write** — `navigate()` in `pane.ts`. Every URL mutation (open, close, setChain) flows through it. Prepend basePath before `pushState`.
- **Read** — `MillerColumns` reads `window.location.pathname` via `usePathname()`. Strip basePath before passing to `useMatchForPath`.

The basePath flows automatically from the app registration to the pane system:

1. Each app declares `path` in its `Apps.App` contribution (already exists: `/debug`, `/deploy`, `/`)
2. `AppsLayout` wraps the active app in a `PaneBasePathContext.Provider` with the app's path
3. `MillerColumns` reads basePath from context, sets module-level state, strips pathname before matching
4. `navigate()` reads module-level basePath and prepends it to the URL

```
pane.open()
  → setChain → buildChainUrl → "/queue"
  → navigate → applyBasePath → "/debug/queue"
  → pushState("/debug/queue")

popstate
  → usePathname() → "/debug/queue"
  → MillerColumns strips → "/queue"
  → useMatchForPath("/queue") → matches queuePane
```

### Key properties

- **Self-contained apps** — navigation stays within the app's URL prefix. Opening a conversation from the debug app produces `/debug/c/abc`, keeping you in the debug app.
- **App switching is explicit** — clicking the app rail navigates with raw `pushState` (bypasses `navigate()`), correctly switching apps.
- **Zero changes to URL machinery** — `parseUrl`, `buildChainUrl`, `getChain`, `setChain`, `buildFreshChain`, `findValidPositions` all unchanged. They work with basePath-stripped paths.
- **Cross-app pane chains work** — panes like `conversationPane` (`after: [null, "attempt", "task-detail"]`) render in whatever app is active. Their segments are matched against the stripped path.
- **Expand callbacks** — `expand()` calls `navigate()` which prepends basePath. Side-pane expansions stay in the current app. For intentional cross-app navigation, use `pushState` directly (like app-rail does).
- **Identical URLs for existing apps** — agent-manager basePath is `""` (no prefix). Debug becomes `/debug/...`. Deploy keeps working as-is (see below).

## Implementation

### 1. Add basePath primitives to `pane.ts`

**React context** (for MillerColumns to read basePath from the app layer):
```ts
export const PaneBasePathContext = createContext<string>("");
```

**Module-level state** (for `navigate()` to read, since it's not a React component):
```ts
let currentBasePath = "";

export function setBasePath(basePath: string): void {
  currentBasePath = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
}
```

**Helper functions** (pure, no side effects):
```ts
function stripBasePath(pathname: string, basePath: string): string {
  if (!basePath || basePath === "/") return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(basePath + "/")) return pathname.slice(basePath.length);
  return pathname; // doesn't match — shouldn't happen if AppsLayout routed correctly
}

function applyBasePath(rawUrl: string): string {
  if (!currentBasePath) return rawUrl;
  if (rawUrl === "/") return currentBasePath || "/";
  return currentBasePath + rawUrl;
}
```

### 2. Modify `navigate()` in `pane.ts`

Prepend basePath before pushState:

```ts
function navigate(url: string, replace = false): void {
  if (typeof window === "undefined") return;
  const fullUrl = applyBasePath(url);
  if (window.location.pathname === fullUrl) return;
  if (replace) {
    window.history.replaceState({}, "", fullUrl);
  } else {
    window.history.pushState({}, "", fullUrl);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.dispatchEvent(new CustomEvent("shell:navigate"));
}
```

No other function in pane.ts changes. `buildChainUrl`, `parseUrl`, `setChain`, `open()`, `close()` — all unchanged.

### 3. Modify `MillerColumns` (`plugins/layouts/plugins/miller/web`)

Read basePath from context. Set module-level state. Strip pathname before matching:

```tsx
import { useContext } from "react";
import { PaneBasePathContext, setBasePath } from "@plugins/primitives/plugins/pane/web";

export function MillerColumns() {
  useSyncPaneRegistry();

  const basePath = useContext(PaneBasePathContext);
  useMemo(() => { setBasePath(basePath); }, [basePath]);

  const rawPathname = usePathname();
  const pathname = stripBasePath(rawPathname, basePath); // pure function, exported from pane
  const match = useMatchForPath(pathname);

  // ... rest unchanged ...
}
```

### 4. Modify `AppsLayout` (`plugins/apps/web/components`)

Wrap the active app in `PaneBasePathContext.Provider`:

```tsx
import { PaneBasePathContext } from "@plugins/primitives/plugins/pane/web";

export function AppsLayout() {
  // ... existing app selection logic ...
  const basePath = activeApp?.path === "/" ? "" : (activeApp?.path ?? "");

  return (
    <div className="flex h-full min-h-0">
      <AppRail ... />
      <div className="min-w-0 flex-1">
        {activeApp && (
          <PaneBasePathContext.Provider value={basePath}>
            <activeApp.component />
          </PaneBasePathContext.Provider>
        )}
      </div>
    </div>
  );
}
```

### 5. Deploy layout override (temporary)

Deploy's panes still have `segment: "deploy"` (the full prefix is in the segment). If `AppsLayout` provides basePath `/deploy`, MillerColumns would strip it — breaking the match. Override basePath to `""` in deploy's layout until deploy panes are migrated:

```tsx
import { PaneBasePathContext } from "@plugins/primitives/plugins/pane/web";

export function DeployLayout() {
  return (
    <PaneBasePathContext.Provider value="">
      <main className="h-full min-h-0 overflow-hidden bg-muted/30">
        <MillerColumns />
      </main>
    </PaneBasePathContext.Provider>
  );
}
```

### 6. Migrate debug pane segments

Remove `debug/` prefix from all debug root pane segments. The basePath `/debug` provides it automatically.

| Pane file | Before | After |
|-----------|--------|-------|
| `debug/plugins/queue/web/panes.ts` | `"debug/queue"` | `"queue"` |
| `debug/plugins/profiling/web/panes.tsx` | `"debug/profiling"` | `"profiling"` |
| `debug/plugins/broadcasts/web/panes.tsx` | `"debug/broadcasts"` | `"broadcasts"` |
| `debug/plugins/memory/web/panes.tsx` | `"debug/memory"` | `"memory"` |
| `debug/plugins/worktree-cleanup/web/panes.tsx` | `"debug/worktree-cleanup"` | `"worktree-cleanup"` |
| `debug/plugins/claude-cli-calls/web/panes.tsx` | `"debug/claude-cli-calls"` | `"claude-cli-calls"` |
| `debug/plugins/db-backup/web/panes.tsx` | `"debug/db-backup"` | `"db-backup"` |
| `debug/plugins/logs/web/panes.tsx` | `"logs"` (BUG) | `"logs"` (unchanged, basePath fixes it) |
| `events-test/web/panes.ts` | `"events-test"` (BUG) | `"events-test"` (unchanged, basePath fixes it) |
| `conversations-recover/web/pane.ts` | `"recovery"` (BUG) | `"recovery"` (unchanged, basePath fixes it) |

Child panes (`logChannelPane` with `after: [logsPane]`, `segment: ":channel"`) don't change — they inherit URL context from their parent chain.

### 7. No changes needed

- **Agent-manager** — basePath is `""` (path `/` normalized to empty). All panes (`c/:convId`, `tasks`, `agents`, etc.) work exactly as today.
- **File-explorer** — basePath `/files`, no panes registered yet. MillerColumns renders nothing.
- **`parseUrl`, `buildChainUrl`** — unchanged. They receive/produce basePath-free paths.
- **`open()`, `close()`, `setChain`, `buildFreshChain`** — unchanged. They work through `navigate()` which adds basePath.
- **`pane.expand()` callbacks** — `navigate()` prepends basePath. `/c/${convId}` stays in the current app.
- **`AppRail.navigateToPath()`** — uses `pushState` directly, bypasses `navigate()`. App switching is absolute.
- **`AppsLayout.appMatchesPath()`** — reads raw `window.location.pathname` (its own `usePathname` clone, not the pane module's). Unaffected.

## Edge cases

**Cross-app open from debug**: `conversationPane.open({convId: "abc"})` from debug app → buildChainUrl → `/c/abc` → navigate → applyBasePath → `/debug/c/abc` → stays in debug app. Self-contained.

**Browser back across apps**: Back from `/debug/queue` to `/c/abc` → popstate → AppsLayout reads raw pathname `/c/abc` → matches agent-manager → renders agent-manager MillerColumns → sets basePath `""` → parses `/c/abc` correctly.

**Direct URL to debug pane in agent-manager**: Typing `/queue` in address bar → full page reload → AppsLayout matches agent-manager → basePath `""` → parseUrl finds `queuePane` (segment `"queue"`) → renders in agent-manager. Non-issue: nobody types these URLs; sidebar navigation always goes through `pane.open()` which prefixes correctly.

## Files to modify

1. `plugins/primitives/plugins/pane/web/pane.ts` — PaneBasePathContext, setBasePath, stripBasePath, applyBasePath, modify navigate()
2. `plugins/primitives/plugins/pane/web/index.ts` — re-export PaneBasePathContext, setBasePath, stripBasePath
3. `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` — read context, set basePath, strip pathname
4. `plugins/apps/web/components/apps-layout.tsx` — wrap active app in PaneBasePathContext.Provider
5. `plugins/apps/plugins/deploy/plugins/shell/web/components/deploy-layout.tsx` — override basePath to ""
6. `plugins/debug/plugins/queue/web/panes.ts` — remove "debug/" from segment
7. `plugins/debug/plugins/profiling/web/panes.tsx`
8. `plugins/debug/plugins/broadcasts/web/panes.tsx`
9. `plugins/debug/plugins/memory/web/panes.tsx`
10. `plugins/debug/plugins/worktree-cleanup/web/panes.tsx`
11. `plugins/debug/plugins/claude-cli-calls/web/panes.tsx`
12. `plugins/debug/plugins/db-backup/web/panes.tsx`
13. `plugins/debug/plugins/logs/web/panes.tsx` — no segment change (basePath fixes the bug)
14. `plugins/events-test/web/panes.ts` — no segment change
15. `plugins/conversations-recover/web/pane.ts` — no segment change

## Deferred work

- **Migrate deploy panes** — change `segment: "deploy"` to `segment: ""`, remove basePath override in DeployLayout. Requires empty-segment root pane handling in `parseUrl`.
- **Pane visibility scoping** — debug panes technically match in the agent-manager if someone navigates to `/queue` directly. Non-issue in practice (no sidebar triggers it), but could add per-pane scope filtering later.

## Verification

1. `./equin build`
2. Open `http://att-1778585996-k28u.localhost:9000/debug`
3. Click each debug sidebar item — URL should stay under `/debug/...`
4. Click "Logs" — URL should be `/debug/logs` (was `/logs`)
5. Click "Queue" — URL should be `/debug/queue` (unchanged)
6. Navigate to `/deploy` — deploy app loads correctly
7. Navigate to `/deploy/add` — deploy add-server form works
8. Browser back/forward across app boundaries works
9. From debug app, clicking conversation/task links stays in debug app
10. App rail switching works (absolute navigation)
11. `./equin check` passes
