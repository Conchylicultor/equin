# Tasks, attempts, conversations, pushes

The mental model behind equin's core entities and their statuses.

## The four entities

| Entity           | Owns                                                          |
| ---------------- | ------------------------------------------------------------- |
| **Task**         | The goal. Nested. Can be dropped by the user.                 |
| **Attempt**      | One try at a task. Owns a worktree on disk.                   |
| **Conversation** | One Claude session. Owns the runtime process (tmux / agent).  |
| **Push**         | A git-push event observed inside an attempt.                  |

```
task  1──*  attempt  1──*  conversation
               │
               └──────*  push
```

- A task is the unit of intent ("fix the diff renderer").
- An attempt is a concrete try, 1:1 with a worktree directory on disk (`claude-<ts>`). If the first attempt fails and you retry, a new attempt is created.
- A conversation is a running Claude session inside an attempt. Today each attempt has exactly one conversation; the model leaves room for many.
- A push is recorded when commits authored inside an attempt land on `main`. It's the "shipped" signal.

## Ground-truth vs derived state

Five write sites are the entire mutation surface. Everything else is computed by a Postgres view.

| Field                         | Writer                                                  |
| ----------------------------- | ------------------------------------------------------- |
| `_conversations.status`       | Runtime adapter (tmux poller today, Agent SDK next).    |
| `_conversations.ended_at`     | Written alongside the transition to `gone`.             |
| `_tasks.dropped_at`           | User action (drop button) only.                         |
| `pushes` row insert           | Push-watcher (detects new commits on `main`).           |
| `_tasks`/`_attempts`/`_conversations` CRUD | Handlers on create / delete.               |

Every other status or timestamp is a column in a `pgView` (`tasks_v`, `attempts_v`, `conversations_v`), derived from the above. No handler ever writes a status field.

## Status vocabularies

### Conversation — `starting` → `working` → `waiting` → `gone`

The only stored status. Owned by the runtime:

- `starting` — process spawning / worktree warming.
- `working` — Claude is actively computing.
- `waiting` — Claude is paused for user input or a permission prompt.
- `gone` — the process has exited (any cause). Terminal. `ended_at` is stamped at the same instant.

Derived: `active = status <> 'gone'`.

### Attempt — `pending` · `in_progress` · `pushed` · `completed` · `dormant` · `closed`

Purely derived from conversations and pushes:

```
has_conv      = any conversation exists for this attempt
has_live_conv = any conversation exists whose status is NOT gone and NOT done
has_open_conv = any conversation exists whose status is NOT done
has_push      = any push row exists for this attempt
```

```
pending      = no conversation yet (attempt was created, nothing ran)
in_progress  = a live conversation is running, no push recorded
pushed       = a live conversation is running AND a push is recorded
completed    = no live conversation AND a push is recorded          (shipped)
dormant      = no live conversation, but one is still open (`gone`)  (resumable)
closed       = every conversation was explicitly closed, no push recorded
```

**Invariant I6 — every arm names a fact the row proves.** A `pushes` row may only
*promote* an attempt to a landed claim (`pushed` / `completed`); its absence may
never select a claim of its own. `dormant` and `closed` report how the *session*
ended and say nothing about what did or did not land — which is why there is no
`abandoned`, and why a task whose work landed on an untrailered commit reads
`attempted` rather than something that asserts failure. See
`tasks/tasks-core/CLAUDE.md` § I6.

Derived: `active = pending | in_progress | pushed` (an agent is expected to be
running). Separately, `retained = has_conv IS NULL OR has_open_conv` — the
retention guard destructive consumers must read, which `dormant` is exactly the
visible name of.

`finished_at` = earliest push time when a push is recorded, else the latest
conversation `ended_at` once every conversation is closed, else NULL — so a
`dormant` attempt never carries one.

### Task — `new` · `in_progress` · `attempted` · `done` · `dropped`

Derived from attempts, with the user's drop timestamp winning over everything:

```
dropped      = user set _tasks.dropped_at   (user intent always wins)
done         = any attempt reached 'completed'
in_progress  = any attempt is active
attempted    = there's been at least one attempt, but none active and none completed (stalled)
new          = no attempt yet
```

Derived: `active = status = 'in_progress'`.

`finished_at` = `dropped_at` for dropped tasks, earliest push time for done tasks, else NULL.

### Why nothing is called "abandoned"

Abandonment is a **user intent**, and the only place it is recorded is
`_tasks.dropped_at` — an explicit action meaning "this isn't worth pursuing",
which wins over any attempt state, so a dropped task stays dropped even if a
lingering attempt later produces a push.

No *attempt* status claims it. An attempt with no push row could have never
pushed, or finished with nothing to push (a research task), or landed on a commit
carrying no attributable trailer, or be waiting on a ledger that has not caught
up — so deriving "abandoned" from the missing row was a verdict the data does not
support (I6). The attempt statuses say how the session ended; the task's
`dropped_at` says what the user decided.

## Cascade

The DB change feed routes each commit to the resources that read the changed table. The `tasks` set (`taskRows`, `tasks-core/server/internal/task-rows.ts`) and the `attempts` set (`attemptRows`, `attempt-rows.ts`) are routed `all` collections over the base tables and the two attempt rollups — never a view — so a write reaches exactly the rows it moves:

- an attempt write: that attempt's row, and its task's (plus the task's dependents);
- a conversation write: its attempt's row (when it moves a column the attempt reads: `attempt_id`, `kind`, `title`, `status`, `created_at`, `spawned_by`, `ended_at`) and, through the `attempt_conv_agg` source route, its attempt's task and that task's dependents (when it moves `status` / `ended_at`);
- a push: its attempt's row and its task's (the `attempt_push_agg` source route on `pushes`, carrying `attempt_id`);
- an edge write: its task and every task that transitively runs after it (the blocking closure's dependents probe).

A conversation going `gone` refills its attempt (`in_progress → dormant`) and its task (`attempted`) in one commit; a write no row reads (a poller's `waiting_for`, a `last_viewed_at`) reaches neither. The conversation lists are still legacy until P8 step 22.

## Schema layout

Each plugin splits its Drizzle schema in two:

- **`server/schema_internal.ts`** — physical `pgTable` definitions for entities that have a derived view. Names are underscore-prefixed (`_tasks`, `_attempts`, `_conversations`). Only in-plugin writers import from here.
- **`server/schema.ts`** — `pgView` definitions (`tasks`, `attempts`, `conversations`), plain tables with no derivation (e.g. `pushes`), Zod schemas, TypeScript types. All cross-plugin consumers import from here.

A plugin's public `index.ts` re-exports from `schema.ts` only. The internal file is never exported to other plugins.

This is enforceable: a check rule forbids cross-plugin imports of `schema_internal.ts`. Writers can only reach the underscored tables inside their own plugin; everyone else sees the unified view.

## Where to read more

- `research/2026-04-16-global-tasks-attempts-conversations-schema-v2.md` — the full schema redesign and migration plan.
- `research/2026-04-16-global-derived-state-primitive-v2.md` — the `pgView` + `dependsOn` primitive that makes the derivation possible.
- `server/CLAUDE.md` — resource / `dependsOn` conventions.
- `plugins/framework/plugins/web-sdk/CLAUDE.md` — plugin schema conventions.
