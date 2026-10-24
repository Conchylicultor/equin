# Build Detail Pane

## Context

The build plugin shows a history list of build runs (in both the toolbar popover and the build pane), but clicking a run does nothing. We want to open a detail pane (miller column) when clicking a run, with extensible sections via `defineDetailSections` — mirroring the `task-detail` pattern so future plugins can contribute sections.

## Approach

Create three sub-plugins under `plugins/build/plugins/`:

1. **`build-detail`** — Pane definition + slot factory (`BuildDetailSlots.Section`)
2. **`build-info`** — Section: status, trigger, commit hash, times, duration
3. **`build-logs`** — Section: live WebSocket log stream

Modify existing `BuildHistoryList` and `BuildPopoverContent` to accept an `onRunClick` callback. Wire it up in both the popover and pane variants.

## New Files

### `plugins/build/plugins/build-detail/`

| File | Purpose |
|---|---|
| `package.json` | `@singularity/plugin-build-build-detail` |
| `web/slots.ts` | `defineDetailSections<{ runId: string }>("build-detail")` → exports `BuildDetail` |
| `web/panes.tsx` | `buildDetailPane` — `after: [buildPane]`, `segment: "r/:runId"`, renders `PaneChrome` + `BuildDetail.Host` |
| `web/index.ts` | `Pane.Register(buildDetailPane)`, exports `BuildDetailSlots` + `buildDetailPane` |

### `plugins/build/plugins/build-info/`

| File | Purpose |
|---|---|
| `package.json` | `@singularity/plugin-build-build-info` |
| `web/components/build-info.tsx` | Receives `{ runId }`, finds run from `buildHistoryResource`, renders status/trigger/commit/times |
| `web/index.ts` | `BuildDetailSlots.Section({ id: "info", ... })` |

### `plugins/build/plugins/build-logs/`

| File | Purpose |
|---|---|
| `package.json` | `@singularity/plugin-build-build-logs` |
| `web/components/build-log-section.tsx` | Adapted from `BuildLogView` — always pane variant, accepts `{ runId }` (unused for now since logs are live-only, not per-run) |
| `web/index.ts` | `BuildDetailSlots.Section({ id: "logs", ... })` |

## Modified Files

### `plugins/build/web/index.ts`
Add `export { buildPane } from "./panes"` so `build-detail` can import it for the `after` chain.

### `plugins/build/web/components/build-popover-content.tsx`
- Add `onRunClick?: (runId: string) => void` prop to `BuildHistoryList` and `BuildPopoverContent`
- Make each history row clickable: `onClick={() => onRunClick?.(run.id)}`
- Add `cursor-pointer` styling when `onRunClick` is provided

### `plugins/build/web/components/build-button.tsx`
- Import `buildDetailPane` from `@plugins/build/plugins/build-detail/web`
- **Popover variant**: pass `onRunClick` that closes popover → opens `buildPane` as root → pushes `buildDetailPane`
- **Pane open button**: no change (already opens `buildPane` as root)

### `plugins/build/web/panes.tsx`
- Import `buildDetailPane` from `@plugins/build/plugins/build-detail/web`
- **Pane variant**: pass `onRunClick` to `BuildPopoverContent` that pushes `buildDetailPane`
- Highlight the selected run using `buildDetailPane.useChainEntry()?.params.runId`

## Key Patterns to Follow

- **Entity lookup**: No per-run server endpoint. Components use `useResource(buildHistoryResource)` and `.find(r => r.id === runId)`.
- **Slot contract**: `defineDetailSections<{ runId: string }>` — every section receives `{ runId: string }`.
- **Barrel purity**: `web/index.ts` files contain only imports, re-exports, and `export default definePlugin(...)`.
- **`StatusDot` + `formatDuration`**: Already exist in `build-popover-content.tsx`. Extract or duplicate in `build-info` (small enough to duplicate).

## Verification

1. `./equin build` — regenerates `plugins.generated.ts`, compiles everything
2. Open `http://<worktree>.localhost:9000`, click Build toolbar button → popover shows history
3. Click a build run → popover closes, build pane opens as root, build-detail pane appears as a second miller column
4. Open build pane directly → click a run → detail pane pushes to the right
5. Detail pane shows: Info section (status, trigger, commit, times) and Logs section (live stream)
