# Unified `StoredModelSchema` — one tolerant persisted-model field

## Context

Commit `4a1e46994` versioned the `ConversationModel` enum (`opus` → `opus-4-8`, …)
and exposed that **the enum value *is* the persisted DB value**: a single stale row
threw a `ZodError` on the WS push path (`notifications-client.ts` `applyUpdate`,
`schema.parse`), blanking the entire array resource. The fix introduced
`tolerantEnum` (`primitives/plugins/live-state/core/tolerant-enum.ts`) and applied it
to the conversation `model` field and the `claude-cli` call-log `model` field, so a
legacy/unknown stored value normalizes (via `normalizeModel`) and fires a deduped
crash signal (via `reportUnknownModel`) instead of rejecting the payload.

**The gap this plan closes:** `autoStartModel` in the `taskAutoStartResource`
live-state resource (`plugins/tasks/plugins/auto-start/shared/resources.ts:8`) still
uses the **raw strict `ConversationModelSchema`**. It's masked today only because the
*server* loader (`auto-start/server/internal/resource.ts:17`) calls
`normalizeModel(r.autoStartModel)` before pushing — tolerance **by convention, not by
construction**. After a future enum change, the same bug class re-opens (narrower
blast radius: the auto-start queued list), and it depends on every loader remembering
to normalize.

A full inventory of `ConversationModelSchema` confirms `autoStartModel` is the **only**
persisted-model field surfaced through a live-state resource that is not yet tolerant.
The other three strict uses are request-input schemas — correctly strict (reject bad
API input loudly): `tasks/core/endpoints.ts:21`, `:47`, `tasks/core/task-chain-types.ts:21`.

**Intended outcome:** a single named `StoredModelSchema` that is *the* way to express a
persisted model field. The three persisted fields route through it (so the tolerance
triple is no longer duplicated/forgettable), and the redundant read-time normalize in
the auto-start loader is removed — mirroring the conversation fix, where tolerance lives
in the schema and the read-time normalize was deleted. Request-input schemas stay strict.

> Decision (this conversation): **shared schema only**, no enforcement check. The
> guarantee is structural-by-construction for the three existing fields; a future *new*
> persisted field relies on the convention of importing `StoredModelSchema`. (An
> enforcement check that flags bare `ConversationModelSchema` outside a request-input
> allowlist was considered and deferred.)

## Design

### 1. Define `StoredModelSchema` — the one persisted-model field

**File:** `plugins/conversations/plugins/model-provider/core/registry.ts`

Add the single canonical tolerant schema, co-located with the model definitions it
wraps (`ConversationModelSchema`, `normalizeModel`, `reportUnknownModel` all live here):

```ts
import { tolerantEnum } from "@plugins/primitives/plugins/live-state/core";

/**
 * THE schema for any *persisted* model id read back through a live-state resource.
 * Tolerant by construction: a legacy/unknown stored value normalizes to a concrete
 * model and fires a deduped crash signal, instead of rejecting the whole array
 * payload on the WS push path. Use this — never raw `ConversationModelSchema` — for
 * a stored model field. Request-input schemas stay strict (`ConversationModelSchema`).
 */
export const StoredModelSchema = tolerantEnum(
  ConversationModelSchema,
  normalizeModel,
  reportUnknownModel,
);
```

Export it from the core barrel: `plugins/conversations/plugins/model-provider/core/index.ts`.

**New dependency edge:** `model-provider/core → primitives/plugins/live-state/core`.
This is a clean DAG edge (live-state/core is zod-only and does not import
model-provider; no cycle). It consolidates an import that `tasks-core` and `claude-cli`
already each carry. The "model-provider/core is zero-dep" note in the plugin's
`CLAUDE.md` becomes "zero *heavy* dep" — live-state/core pulls only zod, which is
already universal. Update that `CLAUDE.md` line accordingly.

### 2. Migrate the three persisted fields onto `StoredModelSchema`

| File:line | Before | After |
|---|---|---|
| `plugins/tasks/plugins/auto-start/shared/resources.ts:8` | `autoStartModel: ConversationModelSchema` | `autoStartModel: StoredModelSchema` (**the fix**) |
| `plugins/tasks-core/server/internal/schema.ts:228` | `model: tolerantEnum(ConversationModelSchema, normalizeModel, reportUnknownModel)` | `model: StoredModelSchema` |
| `plugins/infra/plugins/claude-cli/core/resources.ts:12` | `model: tolerantEnum(ConversationModelSchema, normalizeModel, reportUnknownModel)` | `model: StoredModelSchema` |

Each file's imports collapse: drop the now-unused `ConversationModelSchema`,
`normalizeModel`, `reportUnknownModel`, and `tolerantEnum` imports where they were only
used to build the inline tolerant field, importing `StoredModelSchema` instead.

- `auto-start/shared/resources.ts` — swap the `ConversationModelSchema` import for
  `StoredModelSchema` (both from `@plugins/conversations/plugins/model-provider/core`).
  This is a `shared/` file importing another plugin's core barrel — already the existing
  pattern (it imports `ConversationModelSchema` today), so no boundary change.
- `tasks-core/server/internal/schema.ts` — remove the `tolerantEnum` import (live-state)
  and the `normalizeModel`/`reportUnknownModel` imports **iff** unused elsewhere in the
  file (verify; the file's lead comment at 223–227 explaining the tolerance can stay but
  should point at `StoredModelSchema`). Keep `ConversationModelSchema` import only if
  still referenced elsewhere.
- `claude-cli/core/resources.ts` — same: replace the inline `tolerantEnum(...)` with
  `StoredModelSchema`; drop the four now-unused imports if nothing else needs them.

### 3. Remove the now-redundant server-side normalize (auto-start loader)

**File:** `plugins/tasks/plugins/auto-start/server/internal/resource.ts`

With `autoStartModel` tolerant at the schema, the loader's `normalizeModel(r.autoStartModel)`
is redundant — mirror the conversation fix, which deleted the read-time normalize in
`tasks-core/server/internal/queries/conversations.ts`:

```ts
// before
autoStartModel: normalizeModel(r.autoStartModel),
// after
autoStartModel: r.autoStartModel,
```

Then drop the now-unused `normalizeModel` import (line 5).

**Behavioral note (intended):** today the loader normalize is *silent*. After this
change an unknown stored value normalizes at parse and fires `reportUnknownModel`
(deduped, via `StoredModelSchema`) — i.e. the auto-start field gains the same loud
degrade signal the conversation field already has. This is the desired consistency, not
a regression.

The server `defineResource` `schema: z.array(TaskAutoStartRowSchema)` now references the
tolerant row schema transitively — no change needed there beyond the shared row schema.

### What deliberately stays strict (do not touch)

- `tasks/core/endpoints.ts:21` (`CreateTaskBodySchema.model`), `:47`
  (`SetAutoStartBodySchema.model`) — request bodies; reject bad API input loudly.
- `tasks/core/task-chain-types.ts:21` (`TaskChainLaunchSchema`) — request input.

## Critical files

| File | Change |
|---|---|
| `model-provider/core/registry.ts` | add `StoredModelSchema` (import `tolerantEnum`) |
| `model-provider/core/index.ts` | export `StoredModelSchema` |
| `model-provider/CLAUDE.md` | note the new live-state/core edge; mention `StoredModelSchema` as the persisted-field schema |
| `tasks/plugins/auto-start/shared/resources.ts` | `autoStartModel: StoredModelSchema` (the fix) |
| `tasks/plugins/auto-start/server/internal/resource.ts` | drop read-time `normalizeModel`; drop its import |
| `tasks-core/server/internal/schema.ts` | `model: StoredModelSchema`; prune unused imports |
| `infra/plugins/claude-cli/core/resources.ts` | `model: StoredModelSchema`; prune unused imports |

Reused precedents: `tolerantEnum` (`live-state/core/tolerant-enum.ts`), the conversation
fix shape (`tasks-core/server/internal/schema.ts:228` + deleted read-time normalize in
`queries/conversations.ts`).

## Verification

1. `./equin build` — frontend + server build, migrations regenerate cleanly (no
   enum *values* change → no new data migration). `./equin check --migrations-in-sync`
   green.
2. `./equin check` — full check suite green (no new check added; confirm the
   plugin-boundaries check accepts the new `model-provider/core → live-state/core` edge).
3. **Tolerance regression (the bug):** unit-assert `StoredModelSchema` (and
   `z.array(TaskAutoStartRowSchema)`) — parse rows containing `autoStartModel: "opus"`
   (legacy alias → `opus-4-6`) and `autoStartModel: "totally-unknown"` (→ `DEFAULT_MODEL`),
   assert both normalize and the array still contains every row (no throw). Confirm the
   same for `ConversationSchema` and `ClaudeCliCallSchema` `model` to prove the shared
   schema preserved behavior.
4. **End-to-end auto-start:** with the app running, set a task to auto-start with a model
   (`task-header` Launch / auto-start control), then use `mcp__singularity__query_db` to
   confirm the `tasks_ext_auto_start` row, and confirm the queued chip
   (`auto-start` `QueuedChipAction`) renders in the task list — i.e. the
   `tasks-auto-start` resource is populated, not blanked.
5. Confirm via the `claude-cli-calls` debug pane that call-log rows still render (the
   `claude-cli` `model` field migrated cleanly).
