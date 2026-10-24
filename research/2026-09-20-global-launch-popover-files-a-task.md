# The launch popover files a task, and the task carries the launch

## Context

The Improve popover and the launch-agent popover now share one composer field,
but only Improve is wired to the launch-option registry. Improve draws
preprompt / model / thinking mode from the `tasks.launch-option` slot — one
plugin folder per option, appearing on both the task detail's Prompt card and
the draft popover with no host edit. The launch popover hand-composes its own
`PrepromptPill` and its own fused `RunPill` in
`plugins/primitives/plugins/launch/web/components/`.

So the same three settings are declared twice, and they have already drifted:
the preprompt pill leads with `MdStickyNote2` in Improve (declared in
`task-preprompt/web/index.ts`) and `MdCampaign` in the launch popover (declared
in its own component). Nothing connects them, so nothing could have caught it.
The menu rows below cannot drift, because both read `usePrepromptItems()` and
`PrepromptGlyph` from the plugin that owns preprompts — which is exactly the
shape the trigger glyph is missing.

The recorded reason for the split
(`research/2026-09-20-global-composer-field-improve-launch.md`) is that the
slot's values are written onto a task row and "a launch from here has no task".
That premise is false. `commitConversation`
(`plugins/conversations/server/internal/lifecycle.ts:327-339`) mints a task
whenever `taskId` is absent — `{ title: "Untitled", author: spawnedBy }`,
category `conversations`. Every launch-popover conversation already has a task
behind it. It is just created *implicitly, afterwards, with no options on it*.

So this is not "start creating tasks for these launches". It is **create the
task up front, with its launch options attached, instead of implicitly
afterwards with none**. The row exists either way.

Two things follow from having the task first:

- `prepareConversation` already reads a launching task's preprompt and thinking
  mode off its rows (`getTaskPreprompt` / `resolveTaskEffort`, lifecycle.ts:262
  and 285) whenever `effectiveTaskId` is set. Create the task before the read
  and those settings arrive with **no new code** — and they become durable task
  state, re-applied on every resume and relaunch, instead of one-shot
  conversation inputs.
- `conversations.notify-created` can cover these launches, so the nine bespoke
  `onLaunched` toasts can go.

**One correction to the brief.** That job does *not* currently fire for these
launches, and the reason is not `taskId`. Its gate is `spawnedBy`:

```ts
const CAUSALITY_VALUES = new Set(["user-launch", "dep-resolved", "mcp-add-task"]);
if (!CAUSALITY_VALUES.has(event.spawnedBy)) return;
```

Those three values are only ever set by the auto-start arming path
(`armTaskAutoStart({ cause })`). A browser `POST /api/conversations` carries no
`spawnedBy` at all, so it falls back to `runtimeNamespace()` and the job returns
early. The ten toasts are not duplicating a notification that fires — they are
standing in for one that is one field away from firing. Launching under
`spawnedBy: "user-launch"` is what turns it on.

## What changes

The launch popover's submit stops being "create a conversation with some ad-hoc
settings" and becomes **"file a task with its launch options, and start it
now"** — the same operation the auto-start queue performs, invoked inline
instead of from a job.

That single move collapses everything else: the pills come from the registry
(so the icon drift becomes unspellable), the settings land on the task, the
notification fires, and the popover and Improve differ only in *when* the task
starts.

## 1. One launch path, called from two places

`maybeLaunchTaskJob.run` (`plugins/conversations/server/internal/auto-start-jobs.ts:105-140`)
already is the operation: read the task, prepare, claim the arm and commit in
one transaction (`launchArmedTask`), then finish. Extract its tail into a named
function on the conversations barrel:

```ts
// plugins/conversations/server/internal/auto-start-jobs.ts
export async function launchTaskNow(
  taskId: string,
  opts: { prompt?: string; cause: string },
): Promise<
  | { started: true; conversation: Conversation }
  | { started: false; reason: "not-armed" | "claimed-elsewhere" }
>;
```

It reads the model off the arm marker (`getTaskAutoStart`), defaults `prompt` to
`buildTaskPrompt(task)` (`@plugins/tasks/plugins/tasks-core/core`), calls
`prepareConversation({ taskId, model, prompt, spawnedBy: cause })`, then
`withTaskStatusBatch(tx => launchArmedTask(tx, taskId, prepared))` and
`finishConversation`. `maybeLaunchTaskJob` keeps its gates (`isMain`, dropped /
held, `hasBlockingDep`) and calls it; nothing about the queue's behaviour moves.

The result is a discriminated union, not a nullable conversation — `not-armed`
is a legitimate outcome (the user picked Off), not a failure.

Export `launchTaskNow` from `plugins/conversations/server/index.ts` (the barrel
already exports `maybeLaunchTaskJob`; the internals `prepareConversation` /
`launchArmedTask` / `finishConversation` stay internal).

## 2. A new endpoint: file a task and start it

Contract in `plugins/tasks/core/` beside `createTaskChain`, handler in
`plugins/tasks/server/internal/handle-launch-task.ts` beside
`handle-create-chain.ts`. It must live on the `tasks` side: `tasks/server`
already depends on `conversations/server`
(`plugins/tasks/server/internal/arm-auto-start.ts`), so the reverse edge would
be a cycle — the same constraint that forced `auto-start/plugins/launch-option`
to be its own sub-plugin.

```ts
POST /api/tasks/launch
body: {
  prompt: string;
  options: LaunchOptionValues;                       // keyed by option id
  task: { id: string } | { title: string; categoryId: string };
}
response: { started: true; conversation: Conversation }
        | { started: false; taskId: string };
```

Handler:

1. Resolve every drafted value against `TaskLaunchServer.getContributions()` —
   400 on an unknown id or a failed `schema.safeParse`, **before any task
   exists**. This block is copied verbatim from `handle-create-chain.ts:88-104`
   today; extract it once into `plugins/tasks/plugins/launch-options/server` as
   `resolveLaunchOptions(values)` and have both handlers call it. The collection
   plugin owns the parse, as it owns the registry.
2. `task.id` given ⇒ use it. Otherwise `createTask({ title, description: prompt,
   author: "user", titleAuto: true })` then `setTaskCategory(id, categoryId)`.
3. Apply each resolved option with `{ taskId, cause: "user-launch", start: "now" }`.
4. `return launchTaskNow(taskId, { prompt, cause: "user-launch" })`, mapping
   `started: false` to `{ started: false, taskId }`.

`prepareConversation` picks up preprompt and thinking mode off the rows step 3
just wrote, because `effectiveTaskId` is now set. No change there.

## 3. The launch-option contract gains one field

Step 3 cannot use today's apply unchanged. Auto-start's apply *arms*:
`armTaskAutoStart` writes the marker **and enqueues** `maybeLaunchTaskJob`. That
job would then race our inline claim for the same marker — `launchArmedTask` is
exactly-once, so one of the two wins, and if the job wins the endpoint has no
conversation to return even though one was launched. Real race, not theoretical:
the job runs in the same process's worker.

So the apply context says who is about to start the task:

```ts
// plugins/tasks/plugins/launch-options/server/internal/contribution.ts
export interface TaskLaunchContext {
  taskId: string;
  cause: string;
  /**
   * Who starts this task: the queue, once its dependencies clear — or the
   * caller, inline, immediately after this apply returns. An option that ARMS
   * a launch records its value either way, but must not enqueue when the
   * caller is about to claim that arm itself, or two runners race for it.
   */
  start: "queued" | "now";
}
```

Auto-start's apply
(`plugins/tasks/plugins/auto-start/plugins/launch-option/server/index.ts`):

```ts
apply: async ({ taskId, cause, start }, model) => {
  if (!model) return setTaskAutoStart(taskId, null);
  if (start === "now") return setTaskAutoStart(taskId, { model });
  await armTaskAutoStart({ taskId, model, cause });
},
```

Preprompt and effort ignore the field — their applies are pure writes.
`handle-create-chain.ts:170` passes `start: "queued"`. Required (not optional
with a default) so a future host has to say which it is.

This is the one contract change, and it is the smallest thing that states the
difference between the two hosts: Improve arms, the launch popover claims.

## 4. The popover renders the registry

`LaunchOptionPills` — which already groups by `pill.cluster`, splits by
`pill.side`, and falls back to an option's `component` when it declares no pill
— moves from `task-draft-form/web/components/launch-option-pills.tsx` to
`plugins/tasks/plugins/launch-options/web` and is exported. It is generic and
names no contributor, so it belongs to the registry, and both hosts import it
from the one barrel. `task-draft-form` keeps only the wiring to `CardDraft.options`.

`LaunchAgentForm` (`plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx`):

- holds `options: LaunchOptionValues` in local state, seeded from
  `useLaunchOptionDefaults()` — the same shape `CardDraft.options` holds, which
  is exactly what `LaunchControlProps` was designed for ("the HOST owns
  storage… so the same control serves a task that exists and one that does not
  exist yet").
- puts `<LaunchOptionPills/>` on the composer bar in place of the two
  hand-written pills.
- `getRequest` narrows from `LaunchRequest` to
  `{ prompt: string } & ({ taskId: string } | { categoryId: string })` —
  the fork and attempt shapes become **unspellable here**, which is where the
  brief's "a fork-shaped launch should not mint a task" boundary belongs. A
  caller that brings neither a task nor a category is a type error.
- the existing human `title` prop ("Fix this crash") doubles as the new task's
  title.
- submits to `POST /api/tasks/launch`; the callback becomes
  `onSubmitted?: (result) => void` over the same union, since Off files without
  starting. `openAfterLaunch` opens on the started arm only.

Deleted: `preprompt-pill.tsx`, `run-pill.tsx`, and the `showPreprompt` prop
(declared and defaulted inside the plugin, passed by nobody).

`LaunchControl` and `useLaunchConversation` are untouched — ~20 plugins render
the bare control directly and keep their `mod+N` shortcuts and hover-launch.

## 5. The notification replaces nine toasts

Because the endpoint launches with `spawnedBy: "user-launch"`,
`conversations.notify-created` fires: `"Conversation started"` with
`"<task title> · <model>"`, linking to the conversation, deduped per
conversation id. Every future launch button gets it free.

Delete the `onLaunched` toast body from all nine callers:

| file | today's toast |
|---|---|
| `plugins/debug/plugins/reports/web/components/report-detail.tsx` | "Investigating report" |
| `plugins/reports/plugins/launch-fix/web/components/launch-fix-button.tsx` | "Fixing crash" |
| `plugins/build/plugins/build-fix/web/components/build-fix-section.tsx` | "Investigating build failure" |
| `…/jsonl-viewer/plugins/investigate-event/web/components/investigate-event-action.tsx` | "Building a renderer" |
| `…/deploy-history/plugins/investigate-failure/web/components/investigate-failure-action.tsx` | "Investigating deploy failure" |
| `plugins/apps/plugins/prototypes/plugins/gallery/web/components/detail-actions.tsx` | "Improving prototype" |
| `plugins/apps/plugins/prototypes/plugins/gallery/web/components/prototype-gallery.tsx` | "Creating prototype" |
| `plugins/config_v2/plugins/settings/plugins/conflict-agent/web/components/conflict-agent-button.tsx` | "Resolving config conflict" |
| `plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx` | "Building your app" |

`app-grid` is the one that uses the callback for something real (it closes its
own dialog); it keeps `onSubmitted` and drops only the toast.

## 6. Ad-hoc launch settings stop being spellable

After step 4 nothing sends them: `LaunchRequest.prepromptId` / `.effort` are set
only by the form being rewritten, and no `LaunchControl` caller sets either.
Remove them, and remove `prepromptId` / `effort` from
`CreateConversationBodySchema` (`plugins/conversations/core/endpoints.ts:9-30`),
from `CreateConversationOpts`, and the two `opts.X ??` branches in
`prepareConversation` (lifecycle.ts:262, 285) that prefer them over the task's.

That is the rung-1 half of this change: a preprompt or thinking mode that
applies to one conversation but not to its task can no longer be expressed, so
the two cannot drift again. Verify with a repo-wide search for both field names
before deleting.

## 7. Categories

Each caller names its own, per the answer to "required per caller". Existing
orders: conversations 0, system 1, agents 2, improvements 3, reports 4, pages 5,
toolchain 6.

- report-detail and launch-fix pass `{ taskId }` — `investigate(reportId)`
  already files their task under **Reports** and links it to the report. No
  category, no change.
- investigate-event reuses **improvements** (it asks for a renderer). This needs
  `IMPROVEMENTS_CATEGORY_ID` moved from `plugins/improve/shared/constants.ts` to
  `plugins/improve/core/` — `shared/` is plugin-private and a cross-plugin
  import of it fails `plugin-boundaries` R10.
- New `TaskCategory` contributions, each in the plugin that owns the button:
  `build` "Build" (7), `deploy` "Deploy" (8), `prototypes` "Prototypes" (9),
  `config` "Config" (10), `apps` "Apps" (11).

## Files

Changed
- `plugins/conversations/server/internal/auto-start-jobs.ts` (extract `launchTaskNow`), `plugins/conversations/server/index.ts` (export it)
- `plugins/conversations/core/endpoints.ts`, `plugins/conversations/server/internal/lifecycle.ts` (drop the ad-hoc preprompt/effort inputs)
- `plugins/tasks/core/` (+ the `launchTask` contract), `plugins/tasks/server/internal/handle-create-chain.ts` (`start: "queued"`, shared resolve)
- `plugins/tasks/plugins/launch-options/server/internal/contribution.ts` (`start`), `…/launch-options/server` (+ `resolveLaunchOptions`), `…/launch-options/web` (+ `LaunchOptionPills`)
- `plugins/tasks/plugins/auto-start/plugins/launch-option/server/index.ts`
- `plugins/tasks/plugins/task-draft-form/web/` (import the moved pills)
- `plugins/primitives/plugins/launch/web/components/launch-agent-popover.tsx`, `…/launch-control.tsx`, `plugins/primitives/plugins/launch/CLAUDE.md` (the "never from `tasks.launch-option`" note is now wrong)
- the nine caller files above; `plugins/improve/core/` (moved constant)
- five plugins' `server/index.ts` for the new categories

New
- `plugins/tasks/server/internal/handle-launch-task.ts`

Deleted
- `plugins/primitives/plugins/launch/web/components/{preprompt-pill.tsx,run-pill.tsx}`
- `plugins/tasks/plugins/task-draft-form/web/components/launch-option-pills.tsx` (moved)

## Accepted trade-offs

- **No Haiku title.** The task is created with the form's own `title` ("Fix this
  crash"), which is not in `UNINFORMATIVE_TITLES`, so `task-title` leaves it
  alone. That is deliberate: it makes the bell notification deterministic rather
  than racing the title job and reading "Untitled · Opus 5". The dossier is in
  the description, and the category groups the list. A cleaner follow-up would
  be to make `titleAuto` the guard `updateTaskTitle` checks instead of a
  hardcoded string list, so a seeded title can still be refined.
- **Off files without starting.** Picking Off on the run pill creates the task
  and returns `{ started: false }`. The popover closes and the task appears in
  its category, but nothing announces it — `notify-created` is conversation-
  scoped. Reasonable ("file it, don't run it yet"), worth a follow-up if it
  feels silent.
- **Two transactions.** Task creation and apply commit before the launch claims.
  With a model picked, `start: "now"` still writes the arm marker (it is where
  the model lives), so a crash in between leaves the task **armed**: on main the
  boot reconcile then starts it — the launch the user asked for. Off a main
  checkout it stays armed and unstarted until someone starts it. With auto-start
  Off there is no marker, and a crash leaves a filed, unstarted task — a normal,
  visible state. Either way strictly better than today's client-side two-call
  shape in `investigate()`.
- **A re-launch on an existing task starts a new attempt.** The reports bridge
  reuses a report's live task, so "Fix this crash" pressed twice hands the
  handler a task that already has an attempt. `launchArmedTask`'s "a manual
  start raced in" check is right for the queue and wrong here, so the caller
  states which it wants (`skip` for the queue, `launch` for an explicit user
  launch) rather than the handler branching on it.
- **The model is still auto-start's.** "Which model runs this" and "start it
  when unblocked" remain one option. The clean end state splits them into two,
  so both hosts render an identical run cluster — but that changes the Improve
  run pill's menu just after the user approved it, and touches
  `tasks_ext_auto_start`, `armTaskAutoStart` and `add_task`'s `autostart` param.
  Left as a follow-up; `start: "queued" | "now"` is what covers the gap for now.

## Verification

1. `./equin build` in the background, then read
   `~/.singularity/worktrees/att-1789936274-mgl9/build-status.json` for
   `status: ok`.
2. The drift is gone by construction — check by eye that both popovers show the
   same preprompt glyph:
   ```bash
   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --path /home --click "Improve" --viewport 1400x900 --out /tmp/improve
   ```
   and the same from a crash report's "Fix this crash".
3. End to end by hand: open a report, pick a preprompt and a thinking mode in
   the launch popover, launch. Then confirm with `query_db` that the new task
   has rows in `tasks_ext_preprompt` and `tasks_ext_effort`, that its
   `tasks_ext_auto_start` marker is **gone** (claimed inline, so the queue can
   never double-launch), and that its category is the caller's. Open the task
   detail — the Prompt card's launch options should show what you picked in the
   popover, which is the whole point.
4. Confirm the bell shows one "Conversation started · <title> · <model>" entry
   and no toast.
5. Pick Off and submit: a task appears in the category, no conversation starts.
6. Regression on the queue path: file a chain from Improve with auto-start on
   and a dependency, confirm it still arms and launches when the dependency
   settles (`start: "queued"` unchanged).
7. `./equin test plugins/conversations` — `auto-start-launch.test.ts`
   covers `launchArmedTask` and must still pass after the extraction; add a case
   for `launchTaskNow` returning `not-armed`.
8. `./equin test plugins/tasks/plugins/launch-options` and
   `./equin run plugins/tasks/plugins/launch-options/e2e/launch-options-verify.ts`.
9. `./equin check` — plugin boundaries (the moved `LaunchOptionPills` and
   the `improve/shared` → `improve/core` constant both touch R10),
   `plugins-doc-in-sync`, `type-check`.
