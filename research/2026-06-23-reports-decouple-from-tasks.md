# Decouple reports from auto-created tasks

## Context

Today, every non-rate-limited report (crash, slow-op, op-rate, queue-health,
live-state-churn, render-loop) **auto-files a task** under the
`REPORTS_META_TASK_ID` folder, and the bell notification links to that task. This
floods the task list with machine-generated debug rows and conflates "something
was observed" with "someone should work on it."

Reports already live in their own `reports` table
(`plugins/reports/server/internal/tables.ts`) — that **is** the separate store the
request asked for. So the change is not a new database; it is **decoupling reports
from tasks**:

- No report ever auto-creates a task. Reports only ever live in the `reports` table.
- The Debug → Reports pane (`/debug/reports`) gains a **detail sidepane**
  (`/debug/reports/r/<id>`) showing the full report.
- The report notification **deep-links to that report's sidepane**, not a task.
- A task is created **only** when the user clicks **"Launch an agent to
  investigate"** in the sidepane — reusing the existing `LaunchAgentPopover`
  (prompt + model picker). Once a report has an investigation task, the pane shows
  a link to it.

Confirmed decisions: remove auto-task for **all** kinds; investigate via the
prompt+model popover; notification opens the specific report's sidepane.

## Architectural decision — where the route lives (avoid a cycle)

The notification `linkTo` is built in `reports/server`, but the pane it points to
lives in `debug/reports`. `debug/reports` **already imports** `@plugins/reports/core`
(for `reportsResource`) and `@plugins/reports/web` (for the `Reports.KindView`
slot). So defining the new route inside `debug/reports` and importing it from
`reports/server` would create a `reports ⇄ debug/reports` **cycle** — the
`no-cycles` boundary check would fail.

**Resolution (mirrors the existing `taskDetailRoute` precedent):** the domain
core owns the route. `taskDetailRoute` lives in `tasks/plugins/tasks-core/core`
while the pane that binds it lives in a *different* sub-plugin
(`tasks/plugins/task-detail/web`). We do the same: define `reportsRootRoute` +
`reportDetailRoute` in **`plugins/reports/core`**, and have `debug/reports/web`
bind a pane to them.

Resulting edges (all forward, acyclic):
- `reports/core` route file: `defineRoute` only (no app, no new plugin edge).
- `reports/server` → imports `reportDetailRoute` from its own `reports/core`, plus
  `debugApp` from `@plugins/apps/plugins/debug/plugins/shell/core` for the
  `.link(debugApp, …)` call. This mirrors how it imports `agentManagerApp` +
  `taskDetailRoute` today (`record-report.ts:6-7`).
- `debug/reports/web` → imports the routes from `@plugins/reports/core` (already a
  dependency). No new plugin edge.

`defineRoute` takes no app, so the route definition itself stays dependency-free;
the app is supplied only at `.link()` (server) and at pane-mount time (debug app).
Both routes must be co-located in `reports/core` because the child route sets
`parent: reportsRootRoute`.

## Implementation

### Server — stop auto-filing, repoint the notification

**`plugins/reports/core/resources.ts`** (or a new `plugins/reports/core/routes.ts`
re-exported from the core barrel) — **CREATE routes**
```ts
import { defineRoute } from "@plugins/primitives/plugins/pane/core";
export const reportsRootRoute  = defineRoute({ id: "reports", segment: "reports" });
export const reportDetailRoute = defineRoute({ id: "report-detail", segment: "r/:reportId", parent: reportsRootRoute });
```
Export both from `plugins/reports/core/index.ts`.

**`plugins/reports/server/internal/record-report.ts`** — **MODIFY**
- Delete the `ensureTaskForReport(row.id, …)` call and the whole
  `ensureTaskForReport` function (~208–258), the `taskCreationLocks` map (48), and
  the `createTask`/`getTask` import (5). Keep `eq` only if still used elsewhere.
- Swap imports: drop `taskDetailRoute` + `agentManagerApp`; add `reportDetailRoute`
  from `@plugins/reports/core` and `debugApp` from
  `@plugins/apps/plugins/debug/plugins/shell/core`.
- Notification `linkTo` → `reportDetailRoute.link(debugApp, { reportId: row.id })`
  (always present now — no task gate). Drop `taskId` from `metadata`.
- `RecordReportResult`: drop `wasNew`/task semantics; return
  `{ taskId: row.taskId, rateLimited }` (the column stays `null` until investigate
  runs). Verify callers (`handle-report.ts`, `process-hooks.ts` boot flush) don't
  branch on `wasNew`.
- Move `DEBUG_SKILL_HINT`, `REPORTS_META_TASK_ID` usage, and the task-creation lock
  into the new investigate handler (below).

**`plugins/reports/server/internal/investigate.ts`** — **CREATE** (only place that
now creates a report task; reuses the old dedup logic)
```ts
export async function investigateReport(reportId: string): Promise<{ taskId: string }> {
  // serialize on reportId (the per-key lock pattern moved from ensureTaskForReport)
  // re-read row; if row.taskId && getTask(taskId)?.status !== "dropped" → return existing (dedup)
  // spec = ReportKind.getContributions().find(k => k.kind === row.kind)
  // { title, description } = spec.renderTask(row)
  // task = createTask({ folderId: REPORTS_META_TASK_ID, title,
  //                     description: `${description}\n\n${DEBUG_SKILL_HINT}`, author: "reports-plugin" })
  // UPDATE _reports SET taskId = task.id WHERE id = reportId
  // return { taskId: task.id }
}
```
Wrap the DB writes in `runWithoutProfiling` (as the original did). `renderTask` and
`REPORTS_META_TASK_ID` are kept and used here.

**`plugins/reports/shared/endpoints.ts`** — **MODIFY**: add
`investigateReport` endpoint def — `POST /api/reports/:id/investigate`, response
`{ taskId: z.string() }` (match the existing `submitReport` style).

**`plugins/reports/server/index.ts`** — **MODIFY**: register the route, handler
extracts `:id` and calls `investigateReport(id)` (mirror `handleReport`, wrapped via
`infra/endpoints.implement`).

**`plugins/reports/web/...`** — **MODIFY**: export `investigate(reportId)` —
a thin `fetchEndpoint(investigateReport, { id: reportId })` wrapper from
`@plugins/reports/web`.

### Web — detail sidepane + investigate button

**`plugins/debug/plugins/reports/web/panes.tsx`** — **MODIFY**
- Migrate `reportsPane` from `{ id, segment }` to `{ route: reportsRootRoute, component: ReportsBody }`.
- Add `reportDetailPane = Pane.define({ route: reportDetailRoute, component: ReportDetailBody, width: 480 })`.
- `ReportsBody` reads `reportDetailPane.useRouteEntry()?.params.reportId` for the
  selected-row highlight and passes `onSelect` →
  `useOpenPane()(reportDetailPane, { reportId }, { mode: "push" })` into `ReportsView`.
  (Gold pattern: `plugins/tasks/plugins/task-detail/web/panes.tsx`.)

**`plugins/debug/plugins/reports/web/index.ts`** — **MODIFY**: add
`Pane.Register({ pane: reportDetailPane })`. Sidebar `onClick` stays
`openPane(reportsPane, {}, { mode: "root" })` (root route has no params).

**`plugins/debug/plugins/reports/web/components/reports-view.tsx`** — **MODIFY**:
accept `selectedId` + `onSelect(id)`; make each row a clickable button with a
selected style; **remove** the inline `task →` link (moves to the detail pane).

**`plugins/debug/plugins/reports/web/components/report-detail.tsx`** — **CREATE**:
the sidepane body. `const { reportId } = reportDetailPane.useParams()`, find the row
in `reportsResource`. Render:
- Header badges (kind, source, noise, rate-limited, ×count, last-seen) — reuse the
  cluster from `reports-view.tsx`.
- Full message, url, userAgent, first/last seen, fingerprint, worktree.
- Per-kind payload via the existing `Reports.KindView.Dispatch` slot, plus the raw
  `data` JSON below it. (A dedicated `Reports.KindDetail` slot is a clean future
  extension, not required here.)
- **Investigate affordance:**
  - `report.taskId == null` → `<LaunchAgentPopover>` whose `getRequest(userText)` is
    async: `const { taskId } = await investigate(report.id)`, then return
    `{ taskId, prompt: <report context + userText> }`. The popover's
    `useLaunchConversation` creates the conversation bound to that taskId and opens
    its pane. Live-state pushes the updated `report.taskId`, flipping the UI.
  - `report.taskId != null` → "View task →" using
    `taskDetailRoute.link(agentManagerApp, { taskId })` (build via the route helper
    to satisfy `no-hand-built-link-to`), optionally alongside a "launch another
    agent" popover bound to the existing taskId.

### Cleanup — `plugins/reports/plugins/launch-fix/`

`launch-fix` adds a **Fix** button to the in-app plugin-crash banner that launches
on the *auto-created* crash task (`context.taskId`). With auto-tasks gone,
`context.taskId` is always `null`, so the button would stay permanently disabled.

**Recommendation: repoint it to the investigate endpoint** — on click, call
`investigate(reportId)` then launch (so the in-context crash-banner Fix button keeps
working). This requires `ReportContext` to carry `reportId`; verify
`plugins/reports/web/report.ts` and thread it through if missing. *Fallback:* if the
banner Fix button isn't worth keeping, remove the `launch-fix` sub-plugin entirely —
the detail-pane Investigate button subsumes it.

### Migration

**None.** `reports.taskId` already exists and is nullable. Existing rows keep their
`taskId` from past auto-filing and render with the "View task →" link populated. New
reports get `taskId = null` until Investigate runs. No schema change, no backfill.

## Verification (end-to-end)

1. `./equin build`, then trigger a synthetic report — easiest is the
   **live-state-churn emit** debug tool
   (`plugins/debug/plugins/live-state-churn/plugins/emit/`), or force a `crash`.
2. **No auto-task:** `query_db` the `reports` row (`task_id IS NULL`) and confirm no
   new child task under `REPORTS_META_TASK_ID`.
3. **Notification:** bell shows the report; `linkTo` is `/debug/reports/r/<id>`.
4. Click it → Debug → Reports opens with the **detail sidepane** at that id.
5. Click **Launch an agent to investigate** → edit prompt, pick a model, launch.
   Confirm: task created under `REPORTS_META_TASK_ID` (title/desc from
   `spec.renderTask`), `report.taskId` persisted (pane flips to the task link via
   live-state), and a conversation launches/opens.
6. Re-click Investigate on the same report → dedup: same taskId, no second task.
7. `./equin check` passes (`no-cycles`, `no-hand-built-link-to`,
   `plugins-doc-in-sync`).

## Critical files

- `plugins/reports/core/index.ts` + new routes file — **owns** `reportsRootRoute`, `reportDetailRoute`
- `plugins/reports/server/internal/record-report.ts` — remove auto-task, repoint linkTo
- `plugins/reports/server/internal/investigate.ts` — **new** on-demand task creation
- `plugins/reports/shared/endpoints.ts` + `server/index.ts` — investigate endpoint
- `plugins/reports/web/...` — `investigate()` client wrapper
- `plugins/debug/plugins/reports/web/panes.tsx` — route-based root + detail pane
- `plugins/debug/plugins/reports/web/components/report-detail.tsx` — **new** sidepane
- `plugins/debug/plugins/reports/web/components/reports-view.tsx` — row selection
- `plugins/reports/plugins/launch-fix/` — repoint or remove
