# Derived `updatedAt`: declared per column, enforced by the database

## Context

Opening a conversation bumps `conversations.updated_at`, even when nothing in it changed
(`touchConversationViewed` writes `{ lastViewedAt: now, updatedAt: now }`,
`tasks-core/server/internal/mutations/conversations.ts:261`). The cause is structural.
Every write site stamps `updatedAt: new Date()` by hand, so:

- **spurious bumps:** viewing, hibernation (`setConversationHibernated`) and no-op writes
  (`updateConversation` stamps even when every patched value equals the stored one) all
  move it;
- **missed bumps:** a new write that forgets the stamp compiles and silently doesn't bump.

`tasks` has the same design and keeps its exclusions by comment only
(`mutations/clusters.ts:79`: clusterId relabels must not bump; `mutations/tasks.ts:92,170`).

The user's requirement: `updatedAt` reflects only real changes to the record (edits, new
messages, close), never misses a field, and never moves when nothing changed. Agreed
decisions:

- New messages are tracked by a **status proxy**: a turn enters `working` and the reply
  leaves it. No `lastMessageAt` column.
- **Resume after hibernation must be transparent.** `respawnResume` bounces
  waiting → starting → waiting and clears `hibernatedAt`, and none of that may bump. Plain
  `claude --resume` keeps the same `claudeSessionId` (4,475/4,481 conversations in main have
  one session id ever); it is marked not counted anyway.

## Design

### 1. Declaration: `updatedAt` meta on `defineEntity` (infra/entities)

A new top-level `EntityMeta` key, **required whenever the field record has an `updatedAt`
field**:

```ts
updatedAt:
  | "app-managed"                           // explicit legacy opt-out (see §5)
  | { touchedBy: { [K in Exclude<keyof F, "updatedAt">]: TouchRule<InferFieldValue<F[K]>> } }

type TouchRule<T> =
  | boolean                                 // counts on any value change / never
  | { into?: readonly T[]; outOf?: readonly T[] }  // counts only on these transitions
```

- `touchedBy` is a total `Record` over every other column. A new column that isn't
  classified is a **tsc error**. That is the "never miss a field" guarantee.
- The transition rule is typed against the column's own value type, so
  `into: ["wroking"]` is a tsc error. No raw SQL in the declaration.
- An entity with an `updatedAt` field and no `updatedAt` meta is a tsc error (conditional
  type on `"updatedAt" extends keyof F`), so a new table can't skip the decision.

Files: `plugins/infra/plugins/entities/server/internal/types.ts` (`EntityMeta`, new
`TouchRule`), `define-entity.ts`. `defineEntity` also records the compiled spec on the
returned `Entity` and in a module-level registry (§3).

### 2. Enforcement: a generated BEFORE UPDATE row trigger

A pure compiler in entities, `compileDerivedUpdatedAt(tableName, columns, touchedBy)`,
produces:

```sql
CREATE OR REPLACE FUNCTION "<table>_derive_updated_at"() RETURNS trigger AS $$
BEGIN
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION '<table>.updated_at is derived (declared in defineEntity); do not write it';
  END IF;
  IF <bump> THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER "<table>_derive_updated_at"
  BEFORE UPDATE ON "<table>" FOR EACH ROW EXECUTE FUNCTION "<table>_derive_updated_at"();
```

`<bump>` is the OR of, per column:

- `true` → `NEW.c IS DISTINCT FROM OLD.c`
- `{ into, outOf }` →
  `(NEW.c IS DISTINCT FROM OLD.c AND (NEW.c IN (<into>) OR OLD.c IN (<outOf>)))`
- `false` → nothing

(DB column names come from the drizzle table, not the JS keys; values are escaped
literals.)

Properties:

- **No-op writes don't bump**, because the check is `IS DISTINCT FROM`, not "the column
  was in the SET".
- **An app write to `updated_at` is a loud failure** (`RAISE`), for drizzle and raw SQL
  alike. Rewriting a row with its own value (`.set({...row})`) is not a change and passes.
  This is the rung-4 backstop for "don't write it". Rung 2 comes from removing it from our
  patch types (§4).
- INSERT is untouched: the column keeps `defaultNow()`.
- `now()` (transaction start), consistent with the insert default.

### 3. Installation: boot-time, sequenced by the database plugin

This follows the `superseded-trigger` precedent
(`plugins/infra/plugins/jobs/server/internal/superseded-trigger.ts`):
`CREATE OR REPLACE FUNCTION` + `CREATE OR REPLACE TRIGGER` (a SHARE ROW EXCLUSIVE lock
only, with an atomic swap). A sha256 signature of the DDL is stored as the trigger's
`COMMENT`: a catalog-only up-to-date check, then under a `pg_advisory_xact_lock` a re-check
and install, one transaction per table. It survives the dump/restore fork, so a fresh
worktree DB starts up to date.

- The entities server barrel exports `installDerivedUpdatedAt(db)`, which iterates the
  registry that `defineEntity` fills at module eval. Every `tables.ts` is evaluated during
  plugin load, before any `onReadyBlocking`, the same guarantee
  `View.getContributions()` relies on.
- `plugins/database/server/index.ts` `onReadyBlocking` calls it **right after
  `runMigrations`** (the column must exist), under the same `withQueryDeadline` wrapper as
  the other boot DDL. `database → infra/entities` is a new edge; entities imports no
  database code today (fields, server-core, zod-parser only), so there is no cycle. Verify
  with `./equin check plugin-boundaries`.
- After installing, it asserts (rung 4) that each registered table's trigger exists with
  the expected signature. If it doesn't, boot throws.

The existing change-feed STATEMENT-level AFTER triggers are unaffected: they fire after
our BEFORE ROW trigger and see the derived value.

### 4. Adoption

**conversations** (`tasks-core/server/internal/tables.ts`):

| column | rule |
|---|---|
| `title`, `model` | `true` |
| `status` | `{ into: ["working", "done"], outOf: ["working"] }` |
| `id`, `attemptId`, `runtime`, `kind`, `claudeSessionId`, `waitingFor`, `spawnedBy`, `createdAt`, `endedAt`, `closeRequested`, `hibernatedAt`, `lastViewedAt` | `false` |

A turn start or end and a close bump it. Resume (waiting ↔ starting), a pane dying
(→ gone, `endedAt`), viewing and hibernation don't.

**tasks**: this keeps today's documented policy, now declared.

| column | rule |
|---|---|
| `title`, `description`, `droppedAt`, `heldAt`, `folderId`, `rank` | `true` |
| `id`, `groupId`, `clusterId`, `titleAuto`, `author`, `createdAt` | `false` |

(`rank: true` keeps today's behaviour, where a drag reorder bumps the moved task.)

**attempts**: `taskId`, `worktreePath` `true`; `id`, `createdAt` `false`. No update path
exists today, so this is just the declaration.

Then delete every hand-written stamp:

- `mutations/conversations.ts`: `:161` (`updateConversation`), `:196`, `:226`, `:251`,
  `:261`, `:273`. Also drop `updatedAt` from `UpdateConversationPatch` (no caller passes
  it).
- `mutations/tasks.ts`: `:120`, `:189`, `:289`.
- `plugins/tasks/server/internal/handle-move.ts:73-80`.
- Rewrite the policy comments in `clusters.ts:79`, `tasks.ts:92,170` and the tasks-core
  CLAUDE.md "Tree collapse" note to point at the declaration instead of restating it.

`TRANSIENT_CONVERSATION_FIELDS` (`queries/conversations.ts:243`) stays: `updatedAt` now
moves only alongside columns already in the signature, so stripping it is still correct.

### 5. Other entities with an `updatedAt` field

These are mail-core (8 tables), events-core (2), sonata track-mixer (1) and entity-extension
side-tables (`define-extension-shape.ts:121`, via `define-extension.ts`). They get
`updatedAt: "app-managed"`, which keeps today's behaviour, spelled explicitly at each site.
File one follow-up task (via `add_task`) to classify them and then delete the
`"app-managed"` arm, at which point the rule holds for every entity.

Tables not built with `defineEntity` are out of scope. The follow-up task notes that they
should migrate to entities to get the guarantee.

> Done: see `2026-09-25-global-derived-updated-at-remaining-entities.md` — every
> remaining entity is classified and the `"app-managed"` arm is deleted.

## Tests

- `plugins/infra/plugins/entities/server/internal/derived-updated-at.test.ts`:
  - compiler output for each rule kind;
  - type tests (`@ts-expect-error`) for a missing column, a mistyped transition value, and
    a missing `updatedAt` meta.
- A DB test in the same plugin: `createTestDb`, a hand-made stand-in table (the
  `rollup-spec.test.ts` pattern), install twice (idempotent, signature skip), then check:
  - a counted column changed → bumps;
  - the same value written → no bump;
  - an uncounted column → no bump;
  - an `into`/`outOf` transition → bumps, other transitions don't;
  - writing `updated_at` → raises.
- `tasks-core`: a test that runs `runMigrations` + `installDerivedUpdatedAt` on a
  throwaway DB with the real conversations entity:
  - `touchConversationViewed` → no bump;
  - `setConversationHibernated` → no bump;
  - waiting → starting → waiting → no bump;
  - waiting → working → bump; working → waiting → bump;
  - `markConversationClosed` → bump; `markConversationGone` → no bump;
  - `unionTaskClusters` → no bump on tasks.

Run with `./equin test plugins/infra/plugins/entities plugins/tasks/plugins/tasks-core`.

## Verification

1. `./equin build` (background), then `./equin check`.
2. `query_db` on the worktree DB: `pg_trigger` has `*_derive_updated_at` on
   conversations, tasks and attempts, with signature comments.
3. In the worktree app, open an old conversation. `query_db`: `last_viewed_at` moved,
   `updated_at` did not. Send a message: `updated_at` moves when the turn starts and ends.
4. Let a conversation hibernate (or hibernate it), then click it to resume: `updated_at`
   unchanged.
5. Task list "Updated" column: editing a title bumps it; filing a child into a folder
   doesn't bump the folder.
