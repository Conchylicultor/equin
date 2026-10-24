# Build Popover & Pane

## Context

The build toolbar button currently triggers a build on click and shows status dots (spinner/amber/grey/blue). There is no way to see build logs, history, or trigger a build without navigating to the debug logs pane and selecting the "build" channel. The goal is to make the build button open a popover with live logs, a manual build trigger, build history with status/duration, copy-to-clipboard, and a pop-out to a full pane.

## Design

### What the user sees

**Popover** (opened by clicking the toolbar "Build" button):
```
┌─────────────────────────────────────┐
│ Build                    [↗] pop-out│
├─────────────────────────────────────┤
│ [▶ Build]  ● Running (12s)         │  ← controls bar
├─────────────────────────────────────┤
│ 14:32:01  bun install              │  ← live log (h-48, scrollable)
│ 14:32:03  generating migrations... │
│ 14:32:05  running checks...        │
│ 14:32:08  vite build               │
│                         [📋 Copy]  │
├─────────────────────────────────────┤
│ History                             │
│ ● 14:28  auto   3s   exit 0        │  ← last 10 runs
│ ● 14:15  manual 8s   exit 0        │
│ ✖ 13:50  auto  12s   exit 1        │
└─────────────────────────────────────┘
```

**Pane** (pop-out): same layout but log area is `flex-1` and history shows up to 50 rows.

### Server changes

#### 1. `build_runs` DB table — `plugins/build/server/internal/tables.ts` (new)

```
build_runs:
  id          text PK          (nanoid)
  trigger     text NOT NULL    ("manual" | "auto")
  commitHash  text             (git rev-parse --short HEAD)
  startedAt   timestamp tz NOT NULL default now()
  finishedAt  timestamp tz     (null while running)
  exitCode    integer          (null while running)
```

No FK, no indexes beyond PK — the table is small and only queried for latest-N.

#### 2. Build history resource — `plugins/build/server/internal/build-history-resource.ts` (new)

Push-mode `defineResource` with key `"build.history"`. Loader: `SELECT * FROM build_runs ORDER BY started_at DESC LIMIT 50`. Notified after each build start and completion.

#### 3. Shared schema — `plugins/build/shared/resources.ts` (modify)

Add `BuildRunSchema` (Zod) + `buildHistoryResource` descriptor alongside existing `mainAheadCountResource`.

#### 4. `runBuild()` augmented — `plugins/build/server/internal/run-build.ts` (modify)

- Accept `trigger: "manual" | "auto"` parameter (default `"auto"`).
- Before spawning: insert a `build_runs` row (finishedAt=null), get HEAD commit hash.
- After proc.exited: update the row with finishedAt + exitCode.
- Call `buildHistoryResource.notify()` at both start (so UI sees "running") and end.
- The in-process mutex and detached spawn are unchanged.

#### 5. `lastAutoBuildAt` extraction — `plugins/build/server/internal/auto-build-tracker.ts` (new)

Move the in-memory `lastAutoBuildAt` variable out of `build-run-job.ts` into its own module with `get`/`set` functions. This avoids a circular dep (`build-run-job` → `run-build` → `build-history-resource`, and `handle-build-status` → `build-run-job` would be a second path). `build-run-job.ts` calls `setLastAutoBuildAt()`; `handle-build-status.ts` calls `getLastAutoBuildAt()`.

#### 6. Caller updates

- `handle-build.ts`: `runBuild("manual")`.
- `build-run-job.ts`: `setLastAutoBuildAt(...)` + `runBuild("auto")`. Remove the `lastAutoBuildAt` export.
- `handle-build-status.ts`: import from `auto-build-tracker`.

#### 7. Server `index.ts` — add `buildHistoryResource` to `resources` array

No new HTTP route needed — `useResource` gets data via WS push (with `GET /api/resources/build.history` as automatic HTTP fallback).

### Web changes

#### 8. `BuildPopoverContent` — `plugins/build/web/components/build-popover-content.tsx` (new)

Shared content component rendered in both popover and pane. Accepts `variant: "popover" | "pane"`.

Three sections:

**BuildControls**: Build button + current status. On click: POST /api/build, await `waitForRestart`, show toast. Shows "Running (Xs)" with live elapsed timer when a build_run has no finishedAt.

**BuildLogView**: Subscribes to the `"build"` log channel via `useReconnectingWebSocket` at the existing `/ws/logs` endpoint. Sends `{ type: "subscribe", channel: "build" }`. Renders log lines (timestamp + text, stderr in red). Uses stick-to-bottom scroll pattern from `log-viewer.tsx`. Copy button: `navigator.clipboard.writeText(entries.map(e => e.line).join("\n"))`. Height: `h-48` in popover, `flex-1` in pane.

**BuildHistoryList**: `useResource(buildHistoryResource)`. Each row: status dot (green/red/amber-pulse), trigger badge, duration, relative time. Shows 10 in popover, 50 in pane.

#### 9. Build pane — `plugins/build/web/panes.ts` (new)

```ts
export const buildPane = Pane.define({
  id: "build",
  after: [null],
  segment: "build",
  component: BuildPaneBody,  // wraps BuildPopoverContent variant="pane" in PaneChrome
  chrome: { title: "Build", close: true },
});
```

#### 10. `BuildButton` rework — `plugins/build/web/components/build-button.tsx` (modify)

Convert from `<Button onClick={triggerBuild}>` to:
```tsx
<Popover>
  <PopoverTrigger>  {/* existing button visual: spinner, dots */}
  <PopoverContent className="w-[480px] p-0" align="end">
    <header>Build  [pop-out button → buildPane.open({})]</header>
    <BuildPopoverContent variant="popover" />
  </PopoverContent>
</Popover>
```

The existing status polling (getBuildStatus / applyStatus) stays in BuildButton — it drives the toolbar dots and stale-tab detection which are button-centric.

#### 11. Web `index.ts` — add `Pane.Register({ pane: buildPane })`

### Files to create/modify (execution order)

| # | File | Action |
|---|------|--------|
| 1 | `plugins/build/server/internal/tables.ts` | Create |
| 2 | Run `./equin build --migration-name build-runs` | Generate migration |
| 3 | `plugins/build/server/internal/auto-build-tracker.ts` | Create |
| 4 | `plugins/build/shared/resources.ts` | Modify — add BuildRunSchema + buildHistoryResource |
| 5 | `plugins/build/server/internal/build-history-resource.ts` | Create |
| 6 | `plugins/build/server/internal/run-build.ts` | Modify — trigger param, DB insert/update, notify |
| 7 | `plugins/build/server/internal/build-run-job.ts` | Modify — use tracker, pass trigger |
| 8 | `plugins/build/server/internal/handle-build.ts` | Modify — pass "manual" |
| 9 | `plugins/build/server/internal/handle-build-status.ts` | Modify — import tracker |
| 10 | `plugins/build/server/index.ts` | Modify — add buildHistoryResource |
| 11 | `plugins/build/web/components/build-popover-content.tsx` | Create |
| 12 | `plugins/build/web/panes.ts` | Create |
| 13 | `plugins/build/web/components/build-button.tsx` | Modify — popover wrapper |
| 14 | `plugins/build/web/index.ts` | Modify — register pane |

### Key decisions

- **No per-build log storage.** Logs stream from the existing in-memory `"build"` log channel (10k ring buffer). History rows store only metadata. Logs from old builds are lost on restart — acceptable tradeoff; metadata persists.
- **No `buildId` tagging on log lines.** Single-build mutex means all lines in the channel during a build belong to that build. Per-run log correlation is a future enhancement.
- **Reuse existing `/ws/logs` WebSocket** — no new WS route needed.
- **Push-mode resource** for build history — payload is small (50 rows × 5 fields), same for all subscribers.

### Verification

1. `./equin build` — generates migration, deploys
2. Open app, click Build button → popover opens
3. Click Build in popover → see live streaming logs, running status
4. After build completes → history row appears with green dot, correct duration
5. Click pop-out → pane opens with same content, full-height log area
6. Click Copy → paste shows log lines
7. Trigger auto-build (push to main) → history row appears with "auto" badge
8. Restart server → history persists, logs reset (expected)
