# Make `reports` releasable standalone (Edge 2)

## Context

Commit `64a01067f` cut "Edge 1": `infra.health` no longer hard-imports `reports`, so `reports`
left `served-baseline`'s hard closure and served apps (e.g. Sonata) stopped dragging the whole
agent runtime. But `reports` **itself** is still welded to the agent runtime on the server:

```
reports/server → tasks (createTask/getTask/ensureMetaTask, ContainerTask)
reports/server → build/server barrel → git-watcher → worktree   (via getServerBuildId)
```

So any app that wants crash/error reporting at all pulls `tasks` + `build` + `git-watcher` +
`worktree` into its hard closure — reporting can't be shipped in a self-contained released app.
This is the follow-up "Edge 2" (task `task-1782913270618-mdrawn`).

**Goal:** the base "record a report to its own store" path carries no `tasks`/`build` dependency.
The "file an investigation task" behavior registers in **softly** from `tasks` (mirroring the
Edge-1 `defineReportSink` inversion); the "stale-tab via build id" read is decoupled by
**extracting the trivial `getServerBuildId` leaf** out from behind the heavy `build` barrel.

**Decisions (confirmed with user):**
- Build-id: **leaf extraction** (not a sink). `getServerBuildId` is a memoized synchronous
  file read whose only dep is `infra/paths`; the `git-watcher`/`worktree` chain comes entirely
  from the `build/server` *barrel*. A leaf avoids a boot-order race (reports' boot-time
  `backfillNoiseClassification()` reads the build id synchronously) and needs no registration.
- Enforcement: **skip** the whole-subtree composition-closure guard. It would require relocating
  `reports/plugins/launch-fix` (which imports `conversations` + `agent-manager` and is inherently
  agent-runtime). The literal goal — the `reports` umbrella's own closure free of
  tasks/build/git-watcher/worktree — is met by the edge cuts and covered by `plugin-boundaries` +
  `type-check`. `launch-fix` stays where it is (agent-runtime-only sub-plugin, never shipped standalone).

## Pattern being mirrored

`defineReportSink()` (`plugins/primitives/plugins/report-sink/…`) — a module-level
`{ register(fn|null), emit(body) }` closure. The **emitter owns the sink**; the
**capability-holder registers** into it. `emit` no-ops (returns `undefined`) when nothing is
registered; an async handler's promise rejection still propagates through `await`.
Server plugins register in their `onReady` hook (no React); the server registry loads and runs
`onReady` for **every** discovered plugin regardless of who imports it, so a bridge that nothing
imports still boots and wires itself.

---

## Part 0 — Make `defineReportSink` runtime-agnostic (core)

The factory currently lives under `report-sink/web/` and is web-only; server code can't import a
`/web` barrel. Move it to `core` (importable from both runtimes) — it is pure JS with no web deps.

- `git mv plugins/primitives/plugins/report-sink/web/internal/define-report-sink.ts \
       plugins/primitives/plugins/report-sink/core/internal/define-report-sink.ts`
- Create `plugins/primitives/plugins/report-sink/core/index.ts`:
  ```ts
  export { defineReportSink } from "./internal/define-report-sink";
  export type { ReportSink } from "./internal/define-report-sink";
  ```
- Update the 3 existing consumers to import from `@plugins/primitives/plugins/report-sink/core`
  (was `/web`):
  - `plugins/primitives/plugins/error-boundary/web/reporter.ts`
  - `plugins/infra/plugins/health/web/internal/wedge-report-sink.ts`
  - `plugins/infra/plugins/endpoints/web/internal/error-reporter.ts`
- `plugins/primitives/plugins/report-sink/web/index.ts`: drop the `defineReportSink`/`ReportSink`
  re-exports; keep the (now empty-contributions) default plugin definition.

> No server/web re-export of the factory — everyone imports it from `/core` directly (avoids a
> same-plugin barrel-purity smell and any cross-plugin re-export).

## Part A — Edge A: investigation task inverts to a soft sink

### reports side (owns the sink, emits on its own path)

- **New** `plugins/reports/server/internal/investigation-sink.ts`:
  ```ts
  import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

  export interface InvestigationTaskRequest {
    existingTaskId: string | null;
    title: string;
    description: string;
    author: string;
  }

  // reports emits here on its investigate path; the tasks domain registers the
  // task-creating handler. Absent handler (a composition without tasks) → emit
  // returns undefined → investigateReport throws loudly (misconfiguration).
  export const reportInvestigationSink = defineReportSink<
    InvestigationTaskRequest,
    Promise<{ taskId: string }>
  >();
  ```
- **`plugins/reports/server/internal/investigate.ts`** — drop the `createTask, getTask` import
  (line 4) and the `meta-reports` import (line 6); import `reportInvestigationSink`. Replace the
  `getTask`/`createTask`/update block (lines 54–81) with: resolve `spec` (unchanged),
  `const { title, description } = spec.renderTask(row)`, then
  ```ts
  const result = await reportInvestigationSink.emit({
    existingTaskId: row.taskId,
    title,
    description: `${description}\n\n${DEBUG_SKILL_HINT}`,
    author: "reports-plugin",
  });
  if (!result) {
    throw new Error(
      "investigateReport: no investigation-task handler registered (tasks capability absent in this composition)",
    );
  }
  if (result.taskId !== row.taskId) {
    await db.update(_reports).set({ taskId: result.taskId, updatedAt: new Date() })
      .where(eq(_reports.id, row.id));
  }
  return { taskId: result.taskId };
  ```
  Keep the `taskCreationLocks` mutex and the `runWithoutProfiling` wrapper (the suppression ALS
  propagates across the awaited `emit` into the handler's `createTask`/`getTask` DB calls). Keep
  `DEBUG_SKILL_HINT` here (report-domain copy).
- **`plugins/reports/server/index.ts`** — remove: `ensureReportsMetaTask, REPORTS_META_TASK_ID`
  import (7); `ContainerTask` import (8); the `REPORTS_META_TASK_ID` re-export (17); the
  `ContainerTask({ id: REPORTS_META_TASK_ID })` contribution (32); the `await ensureReportsMetaTask()`
  call (54). Add: `export { reportInvestigationSink } from "./internal/investigation-sink"` (+ its
  `InvestigationTaskRequest` type). Keep the existing `setErrorReporter(...)` block (that is the
  server-core error sink, already correctly inverted — reports registers into it).
- **Delete** `plugins/reports/server/internal/meta-reports.ts`.

### tasks side (registers the handler)

- **New** `plugins/tasks/plugins/reports-investigation/` (`package.json`, hand-written `CLAUDE.md`,
  `server/index.ts`). Server-only. Owns the meta-folder id (keep the **exact** existing string so
  the folder task's identity is preserved):
  ```ts
  import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
  import { createTask, getTask, ensureMetaTask } from "@plugins/tasks/plugins/tasks-core/server";
  import { ContainerTask } from "@plugins/tasks/plugins/container-tasks/server";
  import { reportInvestigationSink } from "@plugins/reports/server";

  const REPORTS_META_TASK_ID = "task-meta-reports";

  export default {
    description:
      "Files reports' on-demand investigation tasks: owns the Reports meta-folder and registers the task-creating handler into reports' investigation sink.",
    contributions: [ContainerTask({ id: REPORTS_META_TASK_ID })],
    onReady: async () => {
      await ensureMetaTask(REPORTS_META_TASK_ID, "Reports"); // before register: folder exists
      reportInvestigationSink.register(async ({ existingTaskId, title, description, author }) => {
        if (existingTaskId) {
          const linked = await getTask(existingTaskId);
          if (linked && linked.status !== "dropped") return { taskId: linked.id };
        }
        const task = await createTask({ folderId: REPORTS_META_TASK_ID, title, description, author });
        return { taskId: task.id };
      });
    },
  } satisfies ServerPluginDefinition;
  ```

> Placed under `tasks/`, **not** `reports/plugins/`: the bridge holds the `tasks` dependency, so it
> must live in the subtree that legitimately retains it. A standalone composition simply doesn't
> ship it (sink unregistered → `investigate` throws loudly). This mirrors Edge-1's rule that the
> registrant lives with the retained dependency.

## Part B — Edge B: extract the `getServerBuildId` leaf

- **New** `plugins/build/plugins/server-build-id/` (`package.json`, hand-written `CLAUDE.md`):
  - `server/internal/get-server-build-id.ts` — move the body of the current
    `build/server/internal/server-build-id.ts` verbatim (the memoized `readFileSync` of
    `${WEB_DIST_DIR}/.build-id`, only dep `infra/paths`). Barrel purity forbids the `let cached`
    in `index.ts`, so it stays in `internal/`.
  - `server/index.ts`:
    ```ts
    import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
    export { getServerBuildId } from "./internal/get-server-build-id";
    export default {
      description:
        "Server build-id leaf: reads the .build-id baked into the served bundle. A leaf so stale-tab detection reads it without importing the heavy build barrel (which pulls git-watcher/worktree).",
      contributions: [],
    } satisfies ServerPluginDefinition;
    ```
- **Delete** `plugins/build/server/internal/server-build-id.ts`.
- **`plugins/build/server/index.ts`** — remove the `getServerBuildId` re-export (a barrel must not
  re-export another plugin's symbol). Repoint build's own internal consumer(s) — at least
  `build/server/internal/frontend-hash-resource.ts` — to import `getServerBuildId` from
  `@plugins/build/plugins/server-build-id/server`. (Grep `getServerBuildId` in `build/server` to
  catch any other internal use.)
- **Repoint the 3 reports call sites** from `@plugins/build/server` →
  `@plugins/build/plugins/server-build-id/server`:
  - `plugins/reports/server/internal/record-report.ts:4`
  - `plugins/reports/server/internal/backfill-noise.ts:3`
  - `plugins/reports/plugins/crash/server/internal/render-crash-task.ts:1`

After this, `reports/server` and `reports/crash/server` import the leaf (closure = `infra/paths`
only), never `build`/`git-watcher`/`worktree`.

## Result: reports' server hard deps

Before: `build, database, change-feed, endpoints, paths, runtime-profiler, notifications,
container-tasks, tasks-core`.
After: `database, change-feed, endpoints, paths, runtime-profiler, notifications,
report-sink(core), build/plugins/server-build-id` — none of which pull tasks / build umbrella /
git-watcher / worktree. (`shell/plugins/notifications` closure verified clean.)

---

## Critical files

- `plugins/primitives/plugins/report-sink/{core,web}/…` — factory → core
- `plugins/reports/server/index.ts`, `…/internal/investigate.ts`,
  `…/internal/investigation-sink.ts` (new), delete `…/internal/meta-reports.ts`
- `plugins/reports/server/internal/{record-report,backfill-noise}.ts`,
  `plugins/reports/plugins/crash/server/internal/render-crash-task.ts` — repoint build-id import
- `plugins/tasks/plugins/reports-investigation/…` (new bridge)
- `plugins/build/plugins/server-build-id/…` (new leaf), `plugins/build/server/index.ts`,
  `plugins/build/server/internal/frontend-hash-resource.ts`, delete
  `plugins/build/server/internal/server-build-id.ts`

## Reused utilities (do not reinvent)

- `defineReportSink` — `plugins/primitives/plugins/report-sink/core` (after Part 0)
- `createTask`, `getTask`, `ensureMetaTask` — `@plugins/tasks/plugins/tasks-core/server`
- `ContainerTask` — `@plugins/tasks/plugins/container-tasks/server`
- `ReportKind` / `spec.renderTask` — kept in reports (`reports/server`)

## Verification

1. `./equin build` — regenerates `server.generated.ts` (2 new plugin nodes; reports'
   `dependsOn` drops `build`/`container-tasks`/`tasks-core`; reports/crash drops `build`), doc
   autogen blocks, and migrations (**no schema change** — `_reports.taskId` unchanged, so no new
   migration expected).
2. `./equin check` — must stay green, in particular:
   - `plugin-boundaries` (no cross-plugin re-export; new `tasks → reports` and leaf edges are legal)
   - `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`
   - `composition-closure` (Sonata still passes; no new excludes added)
3. Manual (full deploy at `http://<worktree>.localhost:9000`):
   - Trigger a crash/report, open Debug → Reports, click investigate: a task is filed under the
     "Reports" folder and linked; a second investigate reuses the live task; after dropping it, a
     fresh task is filed. (Exercises the tasks-bridge handler through the sink.)
   - Submit a report whose `buildId` differs from the served `.build-id`: the bell notification
     title carries the "(stale tab)" suffix and the crash task description shows the
     "Origin: stale frontend tab" banner. (Exercises the leaf.)
   - `mcp__singularity__query_db "select id, task_id, kind from reports order by last_seen_at desc limit 5"`
     to confirm `task_id` is linked after investigate.
