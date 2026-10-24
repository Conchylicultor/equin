# Special conversations: filtering, task-tree relationship, and agents

**Companion to**: `research/2026-04-26-yak-shaving-dashboard.md`. That doc designs a yak-shaving plugin whose Sonnet classifier auto-spawns conversations on `conversation.created`. This doc answers the three loose ends the original deferred: how to filter those, where they live in the task tree, and whether they unify with the agents plugin.

## Context

Today every conversation in `_conversations` is created the same way: it's tied to an attempt, the attempt is tied to a task, the task lands somewhere in the user's task tree. That assumption is fine for **user conversations** (the user starts them) and **agent conversations** (the user clicks Launch on a saved prompt). It breaks down for **system conversations** — Sonnet classifiers fired by jobs, future auto-rebuild conversations, anything triggered by code rather than a human.

The yak-shaving design works around this by minting a real task per classifier under `task-meta-yak-shaving` and marking it `dropped` afterwards. This:

- Pollutes the conversation sidebar (one new entry per user conversation).
- Inflates active-task counts on the Stats charts (each classifier is a row in `_tasks`).
- Forces a real `task_attempts` row + a fresh worktree per classifier (waste).
- Fights the schema instead of declaring intent — the `dropped` status is a workaround marker, not a real state.

Before the yak plugin lands and starts spawning auto-conversations, we need a clean primitive for "this conversation is machine plumbing, not user work."

---

## Q1 — Filtering: how do we mark provenance?

### Recommendation: add a `kind` enum column on `_conversations`

```typescript
// plugins/tasks-core/server/internal/tables.ts
kind: text("kind").$type<ConversationKind>().notNull().default("user"),

// plugins/conversations/shared/types.ts (or co-located with status)
type ConversationKind = "user" | "agent" | "system";
```

- **`user`** — manually created by the human (sidebar "+ New", or any `createConversation` call without a `kind` override).
- **`agent`** — launched via the agents plugin (UI button click on a saved agent).
- **`system`** — code-spawned by a job/trigger (yak classifier, future automations).

`kind` is set at conversation creation; it never changes.

### Why a column, not a `spawnedBy` string convention

`spawnedBy` already exists and is used as a free-form text label. It currently holds: `"agents-plugin"`, the worktree name (default), and (per the yak design) `"yak-shaving"`. Three problems with overloading it:

1. **No type safety.** Filtering becomes "string starts with `system:`" or a hand-maintained allow-list of values. Easy to drift.
2. **It conflates two concerns.** `spawnedBy` answers *who* spawned this (human-readable origin); `kind` answers *what category* it belongs to (machine-routable). Each agent plugin instance might want its own `spawnedBy` while sharing `kind = 'agent'`.
3. **Queries get ugly.** `WHERE kind != 'system'` on a query path used in 4 places (see #punch-list) is one line per call site. `WHERE spawnedBy NOT IN ('yak-shaving', 'future-classifier-1', ...)` is a maintenance trap.

Keep `spawnedBy` as the human-readable origin label. Add `kind` as the canonical machine flag.

### Why not infer from task ancestry?

"Conversation is system if its task descends from a system meta-task" is implicit — fragile under task moves, and forces every consumer to walk the task tree to filter. A column on the conversation itself is local, indexed, and decision-time-stable.

### Punch list (server-side filters)

From the exploration, exactly these queries need `WHERE kind != 'system'` (one-line change each):

| File | Symbol |
|---|---|
| `plugins/tasks-core/server/internal/queries/conversations.ts:16` | `listActiveConversations` |
| `plugins/tasks-core/server/internal/queries/conversations.ts:40` | `listRecentGoneConversations` |
| `plugins/tasks-core/server/internal/queries/conversations.ts:52` | `listGoneConversationsBefore` |
| `plugins/tasks-core/server/internal/queries/conversations.ts:27` | `listAllConversationSummaries` *(attempts pane)* |

That single set of filters covers: sidebar list, recovery pane, attempt-view conversations, and yak-shaving's own `buildRebuildPayload` (which must use a filtered query so the classifier doesn't see its own prior runs as input).

The yak-shaving `conversationCreated` trigger binding then uses `match: (t, p) => sql\`${t.kind} != 'system'\`` to filter at the SQL layer — replacing the bail-early guard in the classifier job (`spawnedBy === "yak-shaving"`) with a cleaner, machine-readable predicate. The bail-early guard remains as belt-and-suspenders for now.

---

## Q2 — Where do system conversations live in the task tree?

This is the core design question. Three options, ordered by structural ambition:

### Option B — Keep meta-task, hide via `kind` (cheap, partial)

What the original yak design proposes, plus a `kind` column to filter UI. Each system conversation creates a real `task` under `task-meta-yak-shaving` and a real `attempt` with a fresh worktree.

- **Cost**: `kind` column + ~5 query filters. ~1 day of work.
- **Wart**: Still mints throwaway tasks + attempts + worktrees per classifier. Worktree-cleanup pane will see them as orphans. Stats charts that count tasks (not just conversations) need a separate task-side filter or subtree exclusion. The "create task → mark dropped" theatrics remain.

### Option D — Make `attemptId` nullable; conversations carry their own worktree

System conversations are first-class non-tasks. `_conversations.attemptId` becomes nullable. `worktreePath` lives on the conversation row directly (or is resolved on demand from a sentinel system worktree).

- **Cost**: From the exploration, ~15–20 file change. Hard blockers:
  - `conversations_v` view: `INNER JOIN _attempts` → `LEFT JOIN`.
  - `ConversationSchema`: `worktreePath`/`taskId` become nullable; every consumer that dereferences them grows a guard.
  - `InsertConversationInput.attemptId`: optional.
  - `lifecycle.ts` fork path + `resumeConversation` need null-handling.
  - ~10 web sites doing `worktree={conversation.attemptId}` need the new nullable `worktreePath` field.
- **Win**: Architecturally clean. No phantom tasks, no `dropped` theatrics, no per-classifier worktree.

### Option E — Recommendation: `kind` column + system conversations share an attempt

A middle ground that gets the cleanliness of D for ~the cost of B.

**The idea**: system conversations don't mint their own attempt. They reuse one.

- **For per-conversation classifiers** (yak's `classify-conversation` job): the classifier reuses the *target conversation's* `attemptId`. The classifier runs in the same worktree as the conversation it's analyzing — which it would want to read from anyway, and the runtime already handles multiple tmux sessions per worktree (forks do this today).
- **For batch jobs** (yak's `rebuild-tree`, future classifiers without a target): a single sentinel `attempt` under a sentinel `task-meta-system` task. One task row total in the DB, regardless of how many batch system conversations run. This task has `kind = 'system'` (mirror the column on `_tasks` if we want a parallel filter; otherwise filter by the constant ID `task-meta-system`).

**No schema change to `attemptId` nullability.** No structural rewrite of the view. Filtering is the same `WHERE kind != 'system'` as Option B. The difference: zero throwaway tasks/attempts/worktrees for the per-conversation case, one shared sentinel task for batch jobs.

**Cost**: same as B (kind column + ~5 query filters), plus:
- `createConversation` accepts a `kind` arg (default `'user'`).
- yak's `classify-conversation` job passes `attemptId: targetConv.attemptId, kind: 'system'`.
- yak's `rebuild-tree` job passes `attemptId: SYSTEM_BATCH_ATTEMPT_ID, kind: 'system'` (sentinel attempt ensured at server init alongside `ensureMetaTask`).

**Trade-off vs D**: not all system conversations have a target conversation. Batch jobs need the sentinel attempt machinery. But that's one additional row in `_tasks` and one in `_attempts`, total — not one per spawned conversation. Acceptable.

**Trade-off vs B**: the per-conversation classifier "lives inside" the user conversation's attempt. If the user opens the attempt-view for a conversation, they could see classifier conversations under it. Easy to suppress with `kind != 'system'` (already in `listAllConversationSummaries`). Net cleaner than B's "task in your tree marked dropped."

### Why E over D

D is the pure form of the user's instinct ("not a task"). But D's structural changes ripple far: every web component that reads `conversation.attemptId` — for opening the namespace URL, for routing to the file tree, for the diff viewer — becomes nullable. Each is a small guard, but the surface area is real. And in practice, system conversations *do* run in a worktree somewhere — you can't escape that. E acknowledges this by reusing the worktree of the conversation being analyzed (or a sentinel system worktree for batch jobs), which is what we'd end up wiring anyway under D.

D buys cleanliness at the cost of touching ~10 web call sites to handle null `worktreePath`. E achieves the same user-visible result (no throwaway tasks, no per-classifier worktree, hidden from all surfaces) for the cost of B.

If D's cleanliness is later judged worth it, the migration from E → D is purely additive: same `kind` column, same filter sites; we add a nullable `attemptId` and migrate the sentinel-attempt usages to null. No rework of E's plumbing is wasted.

---

## Q3 — Relation to the agents plugin

### Recommendation: don't unify

The agents plugin and "system spawners" share exactly one primitive — `createConversation({ taskId, prompt, model, spawnedBy })`. That primitive *is* the unification. Building a layer on top to make them look like the same thing would be premature.

Concretely, agents and system spawners diverge:

| Dimension | Agents | System spawners |
|---|---|---|
| **Source of prompt** | DB row authored by the user (`_agents.prompt`) | Code function that builds context payload from live state |
| **Trigger** | UI button click (synchronous user intent) | Job triggered by an event (`conversationCreated`, scheduled, etc.) |
| **Lifecycle** | CRUD via UI (rename, reorder, delete) | None — code-only registration |
| **Visibility** | First-class entries in the Agents pane | Hidden; surface only in a Debug-style admin pane if at all |
| **Result handling** | Conversation appears in the user's task tree as work the user wants done | Result is read by another job (e.g. yak reading MCP-tool side effects), not by the user directly |

A forced "system agent" abstraction would have to make `prompt` polymorphic (string OR a function-by-id), gate every CRUD path behind a `system: boolean`, hide system rows from the agents pane, and add a code-side launch API that bypasses the UI flow. That's a lot of accidental complexity for two things that already share `createConversation`.

### What the unification looks like in practice

The shared layer is the `kind` column and `createConversation`:

```typescript
// agents plugin (UI-driven)
await createConversation({
  taskId, prompt, model,
  spawnedBy: "agents-plugin",
  kind: "agent",
});

// yak classifier (job-driven)
await createConversation({
  taskId: SYSTEM_BATCH_TASK_ID,            // or targetConv.taskId for per-conv classifier
  attemptId: SYSTEM_BATCH_ATTEMPT_ID,      // or targetConv.attemptId
  prompt: payload, model: "sonnet",
  spawnedBy: "yak-shaving",
  kind: "system",
});
```

Both end up in the same `_conversations` table, distinguishable by `kind`, with provenance (`spawnedBy`) for human-readable origin. No new abstraction required.

### Future direction (not now)

If a third "kind" of code-spawned-but-user-visible conversation emerges (e.g. an agent that auto-runs on a cron), we can introduce a `kind = 'scheduled'` value or extend the agents plugin to support code-side trigger registration. That's a real unification opportunity when the second instance shows up — not now, on the basis of one (yak).

---

## Schema changes

```typescript
// plugins/tasks-core/server/internal/tables.ts
type ConversationKind = "user" | "agent" | "system";

export const _conversations = pgTable("conversations", {
  // ... existing columns
  kind: text("kind").$type<ConversationKind>().notNull().default("user"),
});
```

Default `'user'` makes the migration backward-compatible: every existing row becomes `'user'` (correct — they were all manually created or via agents-plugin → re-tag agents-plugin rows to `'agent'` in a one-liner data migration if we want historical accuracy; not required for correctness).

Index: `index("conversations_kind_idx").on(t.kind)` if we expect frequent filtering by kind on large tables. Optional; the column has low cardinality and queries already filter by other indexed columns (`active`, `endedAt`).

### Sentinel rows (for Option E batch jobs)

```typescript
// plugins/conversations/server/internal/meta-system.ts (new)
export const SYSTEM_META_TASK_ID = "task-meta-system";
export const SYSTEM_BATCH_ATTEMPT_ID = "attempt-system-batch";

export async function ensureSystemMeta(): Promise<void> {
  await ensureMetaTask(SYSTEM_META_TASK_ID, "System");
  // Ensure a single attempt row + worktreePath (e.g. main worktree's path).
  await ensureSystemAttempt(SYSTEM_BATCH_ATTEMPT_ID, SYSTEM_META_TASK_ID);
}
```

The sentinel attempt's `worktreePath` is the main worktree (system conversations don't need their own — they read state via the API or DB).

---

## Critical files to modify

### Schema + lifecycle
| File | Change |
|---|---|
| `plugins/tasks-core/server/internal/tables.ts` | add `kind` column to `_conversations` |
| `plugins/tasks-core/server/internal/schema.ts` | extend `ConversationSchema` with `kind: z.enum([...])` |
| `plugins/conversations/shared/types.ts` | re-export `ConversationKind` |
| `plugins/conversations/server/internal/lifecycle.ts` | accept `kind` opt; default `'user'`; persist on insert |
| `plugins/conversations/server/internal/meta-system.ts` | **new**: `SYSTEM_META_TASK_ID`, `SYSTEM_BATCH_ATTEMPT_ID`, `ensureSystemMeta` |
| `server/src/init.ts` (or equivalent) | call `ensureSystemMeta()` alongside other `ensureMetaTask` calls |

### Filter punch list
| File | Line | Change |
|---|---|---|
| `plugins/tasks-core/server/internal/queries/conversations.ts` | 16 | `AND kind != 'system'` in `listActiveConversations` |
| ⤳ | 40 | same in `listRecentGoneConversations` |
| ⤳ | 52 | same in `listGoneConversationsBefore` |
| ⤳ | 27 | same in `listAllConversationSummaries` |

### Agents tag
| File | Change |
|---|---|
| `plugins/agents/server/internal/handle-launch.ts` | pass `kind: "agent"` to `createConversation` |

### Yak-shaving (revised from original design)
| File | Change |
|---|---|
| `plugins/yak-shaving/server/internal/jobs/classify-conversation.ts` | reuse target conversation's `attemptId`; pass `kind: "system"`; drop the "create task → mark dropped" sequence |
| `plugins/yak-shaving/server/internal/jobs/rebuild-tree.ts` | use `SYSTEM_BATCH_ATTEMPT_ID`; pass `kind: "system"` |
| `plugins/yak-shaving/server/index.ts` | trigger binding uses `match: (t, p) => sql\`${t.kind} != 'system'\`` |
| `plugins/yak-shaving/server/internal/queries.ts` | `buildRebuildPayload` calls `listActiveConversations` (already filtered) |

### Docs
| File | Change |
|---|---|
| `docs/plugins.md` | regenerated by build |
| `research/2026-04-26-yak-shaving-dashboard.md` | append a note pointing here for the system-conversation handling |

---

## Verification

1. **`./equin build`** lands the migration and restarts the server.
2. **Existing conversations get `kind = 'user'`** — `select kind, count(*) from conversations group by kind` shows all rows under `'user'` (or 'user' + 'agent' if the data backfill is included).
3. **Sidebar list** — open any namespace, fire a `POST /api/conversations` with `kind: "system"` (curl directly), confirm it does NOT appear in the sidebar but DOES appear in the conversations table.
4. **Yak end-to-end** (after F lands): create a user conversation → within ~30s a yak node appears for it → the classifier conversation does NOT appear in the sidebar, recovery pane, or attempt-view → it DOES appear in `_conversations` with `kind = 'system'` and reuses the user conversation's `attemptId`.
5. **Stats** — active-tasks chart count stays stable across many classifier runs (no inflation from per-classifier tasks).
6. **Worktree cleanup pane** — no stale per-classifier worktrees appear in the orphan list.

---

## Open questions

1. **Should `_tasks` get a parallel `kind` column?** Today the only "system task" is the sentinel `task-meta-system`. We can filter by ID. If we ever spawn nested system tasks (sub-tasks for batch organization), `kind` on tasks becomes the right answer. Defer until needed.
2. **Should `kind = 'system'` conversations show up anywhere user-visible?** Proposal: a Debug pane (under the existing `Debug.Item` slot) that lists recent system conversations for transparency/debugging. Not a hard requirement for the first slice.
3. **Should agents-plugin retroactively tag historical rows as `kind = 'agent'`?** A one-line UPDATE driven by `spawnedBy = 'agents-plugin'`. Optional; default `'user'` is harmless.
4. **The sentinel system attempt's worktree** — should it be the main worktree, the *current* worktree (the namespace running the server), or a dedicated `system` worktree? Recommendation: the current worktree's path (system conversations are per-namespace, just like every other table here). Validate during implementation.
