# Task track: main track vs sidequest

## Context

Agents file a mix of tasks when they finish work: the next steps of the feature
(the **main track**) and independent follow-ups: caveats, bugs, cleanup (the
**sidequests**). Today `add_task` treats them all the same way: each one is
spliced into the chain and armed for auto-start (default `opus`). So closing a
conversation starts agents on cleanup work too, and a follow-up spliced into
the chain delays the real next step.

Goal: tasks carry a **track** (`main` | `sidequest`).

- **Main track**: tasks filed through Improve / the draft form, and a big
  feature's sequential chain. They are chained and auto-started, as today.
- **Sidequest**: runs after the filing task but is **never spliced** into the
  chain and **never auto-started by an agent**. A separate system will handle
  these later.
- The track shows as an explicit badge in the task list, the task detail header
  and the conversation header.

Example: an agent files 2 follow-ups and 2 main-track steps:

```
current ─┬─> Follow up 1        (sidequest, not armed)
         ├─> Follow up 2        (sidequest, not armed)
         └─> Main 1 ─> Main 2   (main, armed; the old dependents of current now wait on Main 2)
```

When the conversation closes (the current task is done), Main 1 auto-starts
through the existing `taskStatusChanged` → `maybeLaunchTaskJob` path. The
follow-ups do not start.

Decisions (from the user):

- **Auto-start is a filing default, not a hard rule.** The MCP refuses a
  sidequest with `autostart`. A human can still arm a sidequest from the task
  detail's auto-start picker.
- **Sidequest link: runs after, no splice.** The sidequest depends on the
  target task. The target's existing dependents are not rewired onto it.
- **Draft form stays main-only for now.** It has no track control. Everything
  it files is main track.

## Design

### New sub-plugin `plugins/tasks/plugins/task-track`

Built on the `task-category` template (entity-extension side table + resource
+ DataView field). It is **not** registry-driven: the set of tracks is closed,
so it is plain data in `core/`.

- `core/`: `TaskTrackSchema = z.enum(["main", "sidequest"])`, `TaskTrack`,
  `DEFAULT_TASK_TRACK = "main"`, and display metadata (label, icon, badge tint)
  so every badge agrees. Also the `setTaskTrack` endpoint contract
  (`PUT /api/tasks/:id/track`).
- `server/internal/tables.ts`:
  `defineExtension(_tasks, "track", taskTrackShape)`, where the column is
  `track` restricted to the **non-default** tracks (today only `sidequest`).
  **Absence = main**. That default is a real value, not a stand-in for "unknown":
  existing tasks and every `createTask` call site stay main with no backfill.
  Re-export `.table` for drizzle-kit, which generates the migration through
  `./equin build`.
- `server/internal/mutations.ts`: `getTaskTrack(id)` and
  `setTaskTrack(id, track, exec = db)`. `main` deletes the row, `sidequest`
  upserts it. Both follow the `setTaskCategory` shape.
- Live read: `liveCollection` + `serveCollection` over the ext table, per
  `network/live`. Do NOT copy task-category's legacy `queryResource`. The web
  side uses `useLive` / `useLiveRow`, and a row that is absent resolves to
  `main` only once the read is *found / absent*. Pending renders the loading
  state, never "main". Consider `preload: "boot-and-keep"` like category so
  there is no flash.
- `web/`:
  - `TrackBadge`: the one badge component (tinted pill, "Main" / "Sidequest").
  - `TrackField`: a `Tasks.Fields({ id: "track", … })` contribution with an enum
    field (`options` from core). Its `cell` is `TrackBadge`, so task-list rows
    show it explicitly. It can be grouped and filtered, following
    `plugins/tasks/plugins/task-category/web/components/category-field.tsx`.
  - Task detail: a Track row in `TaskHeader`
    (`plugins/tasks/plugins/task-header/web/components/task-header.tsx`) next to
    Status. Clicking the badge switches the track (human override) through the
    endpoint. It is contributed so that task-header does not import task-track,
    or if task-header has no slot, a direct import. Check the boundary DAG
    (task-track → tasks-core only).
- Conversation header: a new sub-plugin
  `plugins/conversations/plugins/conversation-view/plugins/track/` contributes
  `Conversation.Header({ id: "track", component: TrackChip })`. It resolves
  the conversation's `taskId`, reads the track, and renders it through
  `HeaderChip` using the core metadata. It copies
  `conversation-view/plugins/status/web/`. It shows both tracks (explicit
  badge), and nothing for a conversation without a task.

### Filing paths

**`add_task`** (`plugins/tasks/server/internal/mcp-tools.ts`):

- New **required** param
  `track: "main" | "sidequest"`, so the agent must decide each time (tsc/zod
  rather than a silent default). The description is rewritten around the two
  tracks: next steps of the feature → `main`, chained with `target`. Follow-ups,
  caveats, bugs, cleanup → `sidequest`, no `target` chaining needed, filed in
  parallel.
- `autostart` becomes optional. Main track: defaults to `DEFAULT_MODEL_CHOICE`
  as today. Sidequest: passing `autostart` **throws** ("sidequests are never
  auto-started by an agent; a human arms them from the task detail").
  Also `relation: "prerequisite"` with `sidequest` throws: it would block the
  main track on a sidequest.
- Wiring for a sidequest:
  `rewireDependencies({ relation: "followup", selectiveInsertBefore: [] })`.
  That path already exists and means "depend on target, rewire nothing". Then
  `setTaskTrack(task.id, "sidequest")`, and no `armTaskAutoStart`.
- The main track is unchanged: splice + arm.

**Chain endpoint / draft form / Improve**: no change. Every task it creates has
no track row, so it is main. `propose_task` (plugin-health) also creates main,
and it never arms.

**Inheritance**: none. The track is decided per filing (the tool param), like
auto-start. It is not registered as a `TaskLaunchServer` option.

### Auto-start behavior

The launch job (`plugins/conversations/server/internal/auto-start-jobs.ts`)
does not change: the policy lives at filing time. The auto-start picker on a
sidequest's detail still works (the human override).

## Critical files

- New: `plugins/tasks/plugins/task-track/{core,server,shared,web}/…`
- New: `plugins/conversations/plugins/conversation-view/plugins/track/web/…`
- Edit: `plugins/tasks/server/internal/mcp-tools.ts` (param, validation, wiring, docs)
- Edit: `plugins/tasks/plugins/task-header/web/components/task-header.tsx` (Track row)
- Generated: the migration for `tasks_ext_track`, registries, and plugin docs, all through `./equin build`

Reuse: `defineExtension` (infra/entity-extensions), `rewireDependencies`
(`selectiveInsertBefore: []`), `HeaderChip`
(conversation-view/header), `Tasks.Fields` (task-list), and `useLive` / `serveCollection`
(network/live).

## Verification

- Unit test (`./equin test plugins/tasks`): the `add_task` handler with a
  mixed filing (2 sidequests + main1 → main2 off the current task T, where T
  already had a dependent D). Assert these edges: S1→T, S2→T, M1→T, M2→M1,
  D→M2 (not D→S*). Assert that only M1/M2 carry an auto-start marker and that
  S1/S2 have a `sidequest` row. Also assert that sidequest+autostart and
  sidequest+prerequisite throw.
- `./equin build`, then an e2e screenshot of the tasks list (Track column
  / badges), a task detail (Track row, toggling it), and a conversation of a
  sidequest task (header chip).
- Manual: file the example through `add_task` from a conversation, mark the task
  done, and confirm that Main 1 launches and the follow-ups stay unstarted
  (`query_db` on `tasks_ext_auto_start` / attempts).
