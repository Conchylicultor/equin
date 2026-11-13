# Typed launch cause + "Launched from" for conversations

Task: task-1794538993-s6gbht. Follows `2026-11-13-tasks-typed-author-and-filed-from.md`.

## Context

`conversations.spawned_by` is a free string, and each writer decides what to put in it. On main:

| value | rows | what it actually is |
|---|---|---|
| `user-launch` | 1890 | the Launch button (`launchTaskNow`) **or** a task armed from a UI create/chain/set-auto-start |
| `singularity` | 1486 | the `lifecycle.ts:370` fallback `opts.spawnedBy ?? runtimeNamespace()`: every `POST /api/conversations` (new conversation, fork, launch prompts, prototypes) |
| `status-changed` | 1249 | auto-start fired when the task's status moved (blockers cleared) |
| `dep-resolved` | 902 | the same, before 2026-08-18; now only the `maybeLaunchTaskJob` input **default** |
| `auto-start`, `mcp-add-task`, `mcp-edit-task`, `help-ask`, `automation:<id>`, `deps-outdated` | ~1090 | the plugin that **armed** the task, carried through `taskAutoStartArmed.cause` |
| `boot-reconcile` | 26 | the boot catch-up of armed tasks |
| `task-triage`, `agents-plugin`, `conversation-summary`, `sonata-transcription`, `narrowing-fixture`, `yak-shaving` | ~560 | the plugin that launched it |
| `poller` | 145 | adopted from the retired tmux runtime |
| `dep-unblocked`, `slot-freed`, NULL | 43 | legacy |

Readers match on these strings:

- `notify-created-job.ts`: an allow-list (`user-launch`, `dep-resolved`, `mcp-*`). It is already
  broken. Unblocked launches have recorded `status-changed` since August, so the
  "Conversation unblocked" notification has never fired since then. The notification also
  prints the raw string.
- `conversation-item.tsx:201` prints the raw string in front of a system conversation's time.
- `isAdoptedConversation` (`tasks-core/core/adopted.ts`) matches `poller`.
- `spawnedBy` is carried by the all-conversations and tasks-core rows but is not a field, so a
  list can't filter on it.

The column mixes two facts: **why the launch happened now** and **who launched it**. This
change splits it into a closed cause that readers switch on, plus the launching plugin id. The
plugin id works like a task's Filed from. Every caller must state it, with no namespace fallback.

## Design

### The two facts (`tasks-core/core`, next to `task-author.ts`)

```ts
/** Why this conversation was launched at this moment. */
export const CONVERSATION_LAUNCH_CAUSES = [
  "direct",     // its launcher started it as the immediate effect of its own call
                // (Launch / New conversation / fork / launch prompt / saved agent /
                //  triage dispatch / summary / transcription)
  "armed",      // auto-start launched an armed task the moment it was armed
  "unblocked",  // auto-start launched an armed task when what blocked it cleared
  "reconcile",  // auto-start's boot reconcile launched a task a missed wake-up left armed
  "adopted",    // legacy: a session the retired runtime found running. Never written.
] as const;
export type ConversationLaunchCause = (typeof CONVERSATION_LAUNCH_CAUSES)[number];
export const CONVERSATION_LAUNCH_CAUSE_OPTIONS = { direct: { label: "Directly" }, … };

/** Every launch states why and from which plugin. */
export interface ConversationLaunch {
  cause: ConversationLaunchCause;
  from: PluginId;
}
```

- **Launched from** is the `PluginId` of the code that asked for the agent. For an auto-start
  launch, that is the plugin that **armed** the task (`tasks` for `add_task`/`edit_task`,
  `tasks.automations`, `hints.ask`, `tasks.task-list`, …), not the launcher. That way an
  automation's runs read "Launched from: tasks.automations" whatever woke them. The launcher
  itself is already named by the cause.
- "Who" (user / agent / system) is already `conversations.kind`, so it is not stored again.

### Storage (`tasks-core/core/internal/fields.ts`, `server/internal/tables.ts`)

Replace `spawned_by` with:

| column | field | notes |
|---|---|---|
| `launch_cause` | `enumTextField(CONVERSATION_LAUNCH_CAUSES, { label: "Launched", options })` | NOT NULL |
| `launched_from` | `nullable(textField({ label: "Launched from" }))` | NULL only for rows launched before tracking |

`updatedAt.touchedBy`: both `false`. `conversations_v` derives its columns, so the view needs no edit.

### Write API: make the wrong thing unspellable

- `lifecycle.ts`: `CreateConversationFields.spawnedBy?: string` is removed.
  `prepareConversation` takes a **required** `launch: ConversationLaunch`, and
  `PreparedConversation.spawnedBy` becomes `launch`. The `runtimeNamespace()` fallback goes away.
- The public `createConversation(opts)` takes a **required** `launchedFrom: PluginId` and always
  records `cause: "direct"`. A direct caller cannot claim an auto-start cause. Only
  `auto-start-jobs.ts` calls `prepareConversation` with another cause.
- `insertConversation` (`tasks-core/server/internal/mutations/conversations.ts`) takes the two
  columns.
- The `conversationCreated` payload (`tables-events.ts:162`) carries `launchCause` and
  `launchedFrom`. `spawnedBy` is dropped.
- **HTTP** `CreateConversationBodySchema` (`conversations/core/endpoints.ts`) gains a
  **required** `launchedFrom: z.string().min(1)`, validated with `asPluginId` the same way as
  `filedFrom` (`tasks/server/internal/handle-create.ts:61`). The web hook
  `useLaunchConversation` (`primitives/launch/web/components/launch-control.tsx`) and
  `LaunchControl` get a required `launchedFrom` prop. tsc lists every surface that mounts them
  (about 15), plus `launch-prompts-button.tsx`, `new-prototype.ts`, and the todo e2e. The
  launch-task body (`tasks/machine/internal/handle-launch-task.ts`) gains `launchedFrom` too.

#### Auto-start: carry the armer and the wake-up separately

Today one `cause: string` does both jobs, and a status change overwrites it. After this change:

- `armTaskAutoStart({ …, cause: string })` becomes `armedFrom: PluginId`. This also applies to
  the launch-option contribution's `cause` (`tasks/plugins/launch-options/server/internal/contribution.ts`)
  and to the `taskAutoStartArmed` payload (`auto-start/server/internal/tables-events.ts`).
- The auto-start marker (`taskAutoStartShape`) gains `armedFrom` (NOT NULL), written on arm. The
  armer therefore survives until whichever wake-up launches the task.
- `maybeLaunchTaskJob` input becomes `cause: z.enum(["armed","unblocked","reconcile"])` with **no
  default**, which removes the dead `dep-resolved`. The armed trigger passes `"armed"`, the
  status trigger `"unblocked"`, and `auto-start-reconcile.ts` `"reconcile"`.
- `launchArmedTask` / `launchTaskNow` build `launch: { cause, from: ext.armedFrom }`.
  `launchTaskNow` from the Launch button is `{ cause: "direct", from: body.launchedFrom }`.

Writer mapping:

| call site | cause | launched from |
|---|---|---|
| `conversations/machine/internal/handle-create.ts` (new / fork / launch prompt / prototype) | direct | body |
| `tasks/machine/internal/handle-launch-task.ts` (`launchTaskNow`) | direct | body |
| `tasks/plugins/task-triage/server/internal/dispatch.ts` | direct | `tasks.task-triage` |
| `conversations/plugins/agents/machine/internal/handle-launch.ts` | direct | `conversations.agents` |
| `conversations/plugins/summary/machine/internal/handle-generate.ts` | direct | `conversations.summary` |
| `apps/plugins/sonata/plugins/transcription/server/internal/launch.ts` | direct | `apps.sonata.transcription` |
| `debug/plugins/read-set/server/internal/narrowing-fixture.ts` | direct | `debug.read-set` |
| auto-start (armed / status / reconcile) | armed / unblocked / reconcile | marker `armedFrom` |

Armers (`armedFrom`): `tasks` (`add-task-filing.ts`, `manage-tools.ts`), `tasks.task-list` and
the other create/chain surfaces (the body's `filedFrom`, which is already required),
`tasks.auto-start.launch-option`, `tasks.automations` (`define.ts`), `hints.ask`.

### Readers

- **Notification** (`notify-created-job.ts`), as decided by the user: it notifies iff
  `!shownByLauncher && kind !== "system"`, with no allow-list. The "Conversation unblocked"
  wording and the `lock-open` icon are used iff `launchCause === "unblocked"`, which brings the
  unblocked notification back. The detail line is `model · <cause option label>`, never a raw id.
  Behaviour change: automation, help-ask, reconcile, and unseen UI launches (launch prompts, forks
  not opened) now notify. Triage stays silent.
- **Conversation item** (`conversation-item.tsx:201`): a system conversation's meta shows
  `launchedFrom` instead of the raw `spawnedBy`. If the ids registry has a plugin-id presenter it
  is used; otherwise the id is shown as text.
- `isAdoptedConversation` reads `launchCause === "adopted"`, and `ADOPTED_SPAWNED_BY` goes.
- **Lists**: in `all-conversations/core/internal/collection.ts`, `launchCause` and `launchedFrom`
  move from `CONVERSATION_LIST_CARRY` into the listed fields, so **Launched** and **Launched from**
  can filter, group and show as columns. `tasks-core/core/resources.ts`
  `CONVERSATION_QUEUE_CARRY` carries `launchCause`, which `isAdoptedConversation` needs. Removing
  a field means bumping the affected collection keys, as was done for `tasks.v3`.
- Tests and fixtures that insert `spawned_by` (about 12 `*.test.ts`, `all-parity`, `tree-oracle`,
  `classify-queue.test.ts`) switch to `launch_cause`.

### Migration (phased, one push)

`./equin build --custom-migration --migration-name conversation_launch_cause` writes the DML, then
`./equin build --migration-name conversation_launch_cause` generates the expand/contract
(add nullable columns, then SET NOT NULL on `launch_cause` and `tasks_ext_auto_start.armed_from`,
then DROP `spawned_by`). Backfill:

```sql
UPDATE conversations SET launch_cause = CASE
    WHEN spawned_by IN ('status-changed','dep-resolved','dep-unblocked','slot-freed') THEN 'unblocked'
    WHEN spawned_by IN ('auto-start','mcp-add-task','mcp-edit-task','help-ask','deps-outdated')
      OR spawned_by LIKE 'automation:%' THEN 'armed'
    WHEN spawned_by = 'boot-reconcile' THEN 'reconcile'
    WHEN spawned_by = 'poller' THEN 'adopted'
    ELSE 'direct' END            -- user-launch (mostly the Launch button), namespace, launchers, NULL
  WHERE launch_cause IS NULL;
UPDATE conversations SET launched_from = CASE
    WHEN spawned_by = 'task-triage' THEN 'tasks.task-triage'
    WHEN spawned_by = 'agents-plugin' THEN 'conversations.agents'
    WHEN spawned_by = 'conversation-summary' THEN 'conversations.summary'
    WHEN spawned_by = 'sonata-transcription' THEN 'apps.sonata.transcription'
    WHEN spawned_by = 'narrowing-fixture' THEN 'debug.read-set'
    WHEN spawned_by LIKE 'automation:%' THEN 'tasks.automations'
    WHEN spawned_by IN ('mcp-add-task','mcp-edit-task') THEN 'tasks'
    WHEN spawned_by = 'help-ask' THEN 'hints.ask' END
  WHERE launched_from IS NULL AND spawned_by IS NOT NULL;
-- live markers armed before tracking: the launcher's own plugin
UPDATE tasks_ext_auto_start SET armed_from = 'tasks.auto-start' WHERE armed_from IS NULL;
```

`user-launch` was written both by the Launch button and by arming from a UI create, so the old
string cannot tell them apart. It maps to `direct`, the more common case, and `launched_from`
stays NULL because the old string never recorded the surface.

## Verification

- `./equin check`: tsc must find every caller once `spawnedBy` is removed and
  `launchedFrom`/`launch`/`armedFrom` are required. `migrations-in-sync` and the doc and registry
  in-sync checks must pass.
- `./equin test plugins/conversations plugins/tasks/plugins/tasks-core plugins/tasks/plugins/auto-start plugins/conversations/plugins/conversations-view`.
- Add a `notify-created` unit test: unblocked uses the unblocked wording, `shownByLauncher` stays
  silent, `kind: system` stays silent.
- `./equin build`, then in the worktree DB (`query_db`): `launch_cause` / `launched_from`
  counts match the backfill, and `spawned_by` is gone.
- Drive the build: launch a task with Launch and check `direct` plus the surface's plugin id. File
  a task with a blocker and auto-start, close the blocker, and check `unblocked` with
  `launched_from` set to the armer. The bell should show "Conversation unblocked". In All
  conversations, filter by **Launched**.
