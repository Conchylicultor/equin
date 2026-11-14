# supervisor-roles

User-defined, long-lived areas of responsibility (Harness, App perf, Bug
reports, Misc…), each with a backlog its supervisor sessions work through.
Design: the wiki page "Supervisor roles — design" (under Harness › Dark factory
(orchestration)); this plugin is its server/data half. The UI is
`plugins/pane` (the Supervisors sidebar entry and pane, the task detail's
Supervisor pill); sessions — launch, the pane's Adopt and the role session
tools — are `plugins/sessions`.

## Model

- **Roles** — `supervisor_roles` (`core/internal/roles.ts`): `name` (unique,
  case-insensitive), `icon` (Haiku's pick from name + description, re-picked
  when either changes, unless `iconByUser`; null until the first pick),
  `listed`, `description`, `prompt`. Read whole as
  `supervisor-roles.all` (capped at `SUPERVISOR_ROLES_MAX`, the create
  endpoint refuses one more). Written through `POST /api/supervisor-roles`,
  `PATCH /api/supervisor-roles/:id` (`icon: null` hands the icon back to
  Haiku) and `DELETE …/:id`
  (`deleteRoleReleasing`: 409 while the role has a live session or a
  backlog; otherwise it RELEASES what it
  owned — each ended session root states the interactive mandate instead,
  every owner row goes, then the role; no task is deleted).
- **Who owns a task** — `tasks_ext_supervisor` (`taskId → supervisor`, plus
  `filedFromTaskId`: the task whose agent filed it into a backlog), exposed
  as the `supervisor` field of every task list (options: the roles, by
  name). The role is a FK, ON DELETE RESTRICT (the delete releases the rows
  first). The row sits on the ROOTS a
  role owns — its backlog tasks and its session roots; an adopted task's row
  is deleted (the tree's root carries the role). Routing a backlog task is
  just setting it: `PUT /api/tasks/:taskId/supervisor`, or the session tool
  `route_task`; a session root's role is fixed (409 / refused) — the session
  works for it. Not the task category (the surface that filed it).
- **Backlog** of role R (`roleBacklogWhere(R)` in `core/internal/where.ts`,
  the ONE definition the server and the pane share, over tasks-core's
  `taskWindow`): root tasks owned by R that are not its session roots and
  have not run (`new` / `blocked` / `held`). A backlog task states the
  **interactive** mandate (every root names one; a person launching it by
  hand gets an ordinary agent) and is never armed.
- **Sessions** of role R (`roleSessionsWhere(R)`): root tasks owned by R that
  state the `supervisor-role` mandate. Live until `attempted` / `done` /
  `dropped` (`isLiveSessionStatus`); one live session per role (the launch
  endpoint, `plugins/sessions`, serializes on an advisory lock and answers the
  live one instead of launching a second).
- **Mandate** — ONE named mandate, `supervisor-role` (`supervisorRoleMandate`,
  a kind of `supervisor`: `extends: supervisorMandate`):
  `supervisorPolicy({ root: [supervisorRole.grant(true)] })`, computed at each
  resolution. It is OWNED (`owned: { refiledAs: interactiveMandate }` on its
  definition — orchestration/mandate/definitions): a task states it only with
  an owner row beside it, so no path leaves a role-less session root. Only the
  launch states it; the Mandate select does not offer it and its endpoints
  refuse to state or unstate it; a task re-filed out of a session's tree to the
  root states the interactive mandate instead of copying it (tasks-core's
  `prepareRefile`), leaving the role; a session root's owner row is fixed
  (`isSessionRoot` — any task stating the mandate, nested or not). WHICH role a session works for is its root task's `supervisor`
  field (`roleOfConversation`), never encoded in the mandate id — two sources
  of truth that could disagree. The role powers (`supervisorRole`, root only):
  the session tools (`plugins/sessions`) and a `MandateReach` — a role session
  manages (edit_task / drop_task) every task whose tree root its role owns:
  its backlog and its earlier session trees, never another role's — edit and
  drop only: `edit_task` never ARMS a task outside the caller's tree (a
  backlog task is adopted, so it runs in the session's tree; an ended session
  is relaunched only through the launch endpoint).
- **Filing** — `add_task` with `supervisor: "<role id>"` (tasks'
  `machine/`) calls `fileToBacklog`: needs the `tasks.file` grant's
  `backlog` (granted by the interactive and supervisor presets), `start:
  "manual"`, no `after` / `relation` / `model`. Only a LISTED role may be
  named. There is no catch-all ref: work no specific role fits goes to a
  listed general-purpose role, named like any other.
- **Arrival notice** — a task entering role R's backlog (`fileToBacklog`, or
  `setTaskSupervisorRole` giving it a new owner: `route_task`, the pane's
  Supervisor pill) emits `supervisorRoles.backlogArrived`, on the write's
  transaction. The desktop's watch source (`machine/`) turns it into one
  `backlog` event about the task, routed (`routeTaskId`) to R's live session
  root — its tree watch delivers it as an event turn once the agent is idle,
  batched with whatever else arrived. Checked when ingested: a task no longer
  in the backlog, or a role with no live session, says nothing (the next
  session reads its backlog). The filing agent never hears its own filing.
- **System prompt** — `supervisor-roles` section: the listed roles (name, id,
  description) and how to file, for a conversation whose grant has
  `backlog`. `supervisor-prompt` section: for the conversation at the ROOT of
  a mandate that is a kind of `supervisor` (`mandateIsKindOf` over the
  definitions' lineage — `supervisor-role` among them; never a worker), a role
  session's role line plus the shared supervisor prompt
  (`supervisorPromptConfig` in `core/`, so the pane edits it too — Settings
  → Config → Supervisors, or the pane's All supervisors entry). Order seen by a
  role session: its system prompt (preprompt, then these sections), then its
  first turn — the role's prompt, snapshotted into the session task's
  description at launch.
- **Icon** — server emits `supervisorRoles.iconStale` (create, or a name /
  description edit while the icon is Haiku's, or `icon: null`); the desktop
  `machine/` job `supervisor-roles.icon` (keyed, settled) asks Haiku and
  writes only while the role is unchanged and not hand-picked. A host without
  a model hears nobody.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Supervisor roles, web half: registers the srole id kind, the shared supervisor prompt config (Settings → Config) and the exposed `supervisor` field of every task list, its options the live roles by name. Supervisor roles, data half: the supervisor_roles table (name, Haiku-picked icon with a person's override, listed, description, prompt, the queue section its sessions land in — contributed as Queue.LaunchSection) served whole as supervisor-roles.all with its create / edit / delete endpoints; the per-task owner (tasks_ext_supervisor, a role id, exposed as the `supervisor` field of every task list, routed by PUT /api/tasks/:taskId/supervisor); filing into a role's backlog (fileToBacklog — a root task owned by the role, never armed); the supervisor-role mandate (the supervisor preset plus the role powers on the root) and its reach (a role session manages every task its role owns); the system-prompt sections listing the listed roles to agents that may file into a backlog, and the shared supervisor prompt (a config) for every supervisor root.
- Web:
  - Contributes:
    - `IdKinds.Kind` "srole"
    - `ConfigV2.WebRegister` "Supervisors"
    - `FieldPresentation.Register` "exposure:tasks_ext_supervisor"
  - Uses:
    - `config_v2.ConfigV2`
    - `ids.IdKinds`
    - `network/live.FieldPresentation`
    - `network/live.LiveFieldOption`
    - `network/live.LiveFieldOptionsRead`
    - `network/live.useLive`
    - `network/live/live-state.mapResource`
- Server:
  - Contributes:
    - `ids.kind` "srole"
    - `ConfigV2.Register` "Supervisors"
    - `resource.declare` "supervisor-roles.all"
    - `resource.declare` "supervisor-roles.all:rows"
    - `resource.declare` "task-supervisors.by-id:rows"
    - `live.columns.expose` "tasks ← tasks_ext_supervisor"
    - `mandateDefinition` "supervisor-role"
    - `conversations.conversations-view.queue.launch-section` "supervisor-role-session"
    - `mandateCapability` "supervisor-roles.role"
    - `mandateReach` "supervisor-roles"
    - `conversations.system-prompt.section` "supervisor-prompt"
    - `conversations.system-prompt.section` "supervisor-roles"
    - `watchSource` "supervisor-roles.backlog"
    - `trigger` "supervisor-roles.icon"
    - `trigger` "watch.ingest"
  - Uses: 31 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `tasks/tasks-core` ×6
    - `tasks/orchestration/mandate` ×4
    - `config_v2` ×2
    - `conversations/conversations-view/queue` ×2
    - `database` ×2
    - `infra/endpoints` ×2
    - `infra/entities` ×2
    - `network/live` ×2
    - `tasks/orchestration/mandate/definitions` ×2
    - `conversations/system-prompt.SystemPrompt`
    - `ids.IdKinds`
    - `infra/entity-extensions.defineExtension`
    - `infra/events.defineTriggerEvent`
    - `tasks/mandate-presets.supervisorPolicy`
    - `tasks/task-track.setTaskTrack`
    - `ui/icons/saved-sources.defineSavedIconSource`
  - DB schema:
    - `plugins/tasks/plugins/supervisor-roles/server/internal/tables-events.ts`
    - `plugins/tasks/plugins/supervisor-roles/server/internal/tables.ts`
  - Entity extension of: `tasks/tasks-core` (table `tasks_ext_supervisor`)
  - Exports (types):
    - `BacklogFiling`
    - `RoleTaskRow`
    - `SupervisorRoleBacklogArrivedPayload`
    - `SupervisorRoleIconStalePayload`
  - Exports (values):
    - `_supervisorRoles`
    - `BACKLOG_READ_LIMIT`
    - `fileSystemBacklogTask`
    - `fileToBacklog`
    - `getSupervisorRole`
    - `isInRoleBacklog`
    - `isSessionRoot`
    - `liveSessionOf`
    - `lockRoleSessions`
    - `roleBacklog`
    - `roleOfConversation`
    - `setTaskSupervisorRole`
    - `supervisorOfTask`
    - `supervisorRoleBacklogArrived`
    - `supervisorRoleIconStale`
    - `tasksSupervisor`
  - Register:
    - `defineTriggerEvent('supervisorRoles.iconStale')`
    - `defineTriggerEvent('supervisorRoles.backlogArrived')`
  - Resources:
    - `supervisor-roles.all` (keyed)
    - `supervisor-roles.all:rows` (keyed, point)
    - `task-supervisors.by-id:rows` (keyed, point)
  - Routes:
    - `POST /api/supervisor-roles`
    - `PATCH /api/supervisor-roles/:id`
    - `DELETE /api/supervisor-roles/:id`
    - `PUT /api/tasks/:taskId/supervisor`
- Machine:
  - Uses: `tasks/orchestration/watch.watchSource`
  - Register: `defineJob('supervisor-roles.icon')`
- Core:
  - Uses: 28 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `tasks/tasks-core` ×4
    - `fields` ×3
    - `ids` ×3
    - `network/live` ×3
    - `fields/text/config` ×2
    - `tasks/orchestration/mandate/policy` ×2
    - `ui/icons/saved-names` ×2
    - `config_v2.defineConfig`
    - `conversations/conversations-view/queue.conversationSectionIdKind`
    - `fields/bool/config.boolField`
    - `fields/date/config.dateField`
    - `fields/multiline-text/config.multilineTextField`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `infra/entity-extensions.defineExtensionShape`
    - `tasks/mandate-presets.supervisorMandate`
  - Exports (types):
    - `CreateSupervisorRoleBody`
    - `SetTaskSupervisorBody`
    - `SupervisorRole`
    - `SupervisorRoleId`
    - `TaskSupervisorRow`
    - `UpdateSupervisorRoleBody`
  - Exports (values):
    - `BACKLOG_STATUSES`
    - `createSupervisorRole`
    - `CreateSupervisorRoleBodySchema`
    - `deleteSupervisorRole`
    - `ENDED_SESSION_STATUSES`
    - `isLiveSessionStatus`
    - `roleBacklogWhere`
    - `roleSessionsWhere`
    - `setTaskSupervisor`
    - `SetTaskSupervisorBodySchema`
    - `SUPERVISOR_ROLES_MAX`
    - `supervisorPromptConfig`
    - `supervisorRole`
    - `supervisorRoleFields`
    - `supervisorRoleIdKind`
    - `supervisorRoleMandate`
    - `supervisorRoles`
    - `SupervisorRoleSchema`
    - `supervisorRolesEntityRef`
    - `TaskSupervisorRowSchema`
    - `taskSupervisors`
    - `taskSupervisorShape`
    - `updateSupervisorRole`
    - `UpdateSupervisorRoleBodySchema`
- Cross-plugin:
  - Imported by:
    - `tasks`
    - `tasks/supervisor-roles/events`
    - `tasks/supervisor-roles/pane`
    - `tasks/supervisor-roles/sessions`
  - Endpoint callers:
    - `events`
    - `sessions`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables-events.ts` (debt)
- Sub-plugins:
  - **`events`** — Supervisor event streams, web half: registers the supervisor event message and gathered event id kinds, so their ids are recognised in the browser as on the server. Supervisor event streams, data…
  - **`pane`** — The Supervisors pane, in the agent manager: one sidebar entry (live sessions and the tasks waiting in every backlog at its edge) opening the list — the pinned All supervisors entry (the shared…
  - **`sessions`** — Supervisor role sessions: POST /api/supervisor-roles/:id/sessions opens the role's live session or launches one (one live session per role — a root task stating the supervisor-role mandate, owned by…

<!-- AUTOGENERATED:END -->
