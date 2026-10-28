# Deferred contract phase — a phased migration's contract waits for the old code to go

Task: task-1793200704-z9t1tn. Incident: report-1793194155-nq2cmx.

## Context

A hot restart (`gateway/worktree.go` `Restart`) boots the new backend while the
old one keeps serving, and the new backend's `onReadyBlocking` runs the whole
boot schema layer — **expand → claimed data → contract** — before it is ready.
So every contract statement commits while the previous code is still answering
requests, and then while it drains.

Contract is *defined* as the statements that invalidate the code already
deployed (`migrations/CLAUDE.md`, "What is expand and what is contract"). Running
it while that code serves is the bug, for every contract:

- `ADD CONSTRAINT` / `SET NOT NULL` / `CREATE UNIQUE INDEX` — the old code's
  writes are refused. 2026-10-28 13:29: `tasks_root_has_mandate` refused two
  Investigate clicks (old code inserting root tasks with no mandate).
- `DROP COLUMN` / `DROP TABLE` — drizzle names every column, so every old-code
  query on the table fails for the window.

The author did everything right (expand, idempotent backfill, contract in one
push). The fix must not depend on authors splitting pushes.

## Rule

**The contract of a phased group G runs only once no process running code that
predates G holds a database session.** Expand and the claimed data migrations
stay at boot (they keep old code valid by definition).

Rows the old code writes between the backfill and the contract are exactly what
the contract would reject, so **the contract step re-runs G's claimed data
migrations first, in the same transaction.** Claimed data migrations are already
required to be idempotent (CLAUDE.md "Claims"); the dry run now proves it
(it runs them twice).

## Who is "old code": schema-generation locks

Every process that runs the database plugin's `onReadyBlocking` (serve AND exec
children — supervised jobs spawned by the old backend are old code too) takes,
on a dedicated direct (non-pgbouncer) connection held for its whole life, a
**shared session advisory lock `(GEN_CLASS, gen)`**, where `gen` is its schema
generation: the int4 of the sha8 of the latest migration file it ships.
Advisory locks are per database, so each worktree DB is independent; the
session dies with the process, so the lock needs no cleanup.

To run G's deferred contract, the serving backend:

1. computes `newEnough` = the gens of G's file and every file after it in its own
   list (any process whose latest file is one of those knows G);
2. reads `pg_locks` for `GEN_CLASS` holders; every gen outside `newEnough` is
   old;
3. takes `pg_advisory_lock(GEN_CLASS, oldGen)` **exclusive** for each — blocks
   (push, no polling) until every holder of that old gen is gone; an old-code
   process starting meanwhile queues behind it;
4. re-reads `pg_locks`; repeats from 2 until no old gen is held by anyone else;
5. runs the contract transaction; releases the exclusive locks.

New processes only ever take shared locks on new gens, so the waiter never
blocks a newer deploy's boot (the same-key alternative — everyone shares one key
— would queue deploy N+1's shared request behind N's exclusive waiter, stalling
the boot behind a long-running old supervised child).

Pre-feature code holds no lock, so the first deploy of this change still has the
window once — accepted.

## Ledger: `expanded` vs complete

`MIGRATIONS_TABLE_NAME` gains `contract_pending boolean NOT NULL DEFAULT false`
(`ALTER TABLE … ADD COLUMN IF NOT EXISTS` next to the existing `CREATE TABLE IF
NOT EXISTS`; old code reads only `hash, file`, unaffected).

- Boot: a phased file with a non-empty contract is recorded with
  `contract_pending = true` right after its claimed data (its row now lands at
  expand, so a crash before contract never re-runs expand). A file with an empty
  contract records as today.
- `planSchemaSteps(migrations, applied, { contractPending, deferContract })`:
  with `deferContract` (boot) the **last** phased group with SQL records
  `contract_pending` and is returned as `deferredContract`; without it (the
  deferred run, the dry run, the test helper) a pending group completes —
  `reapply` its claimed data, `contract`, `complete` (clears the flag on its
  row and any superseded lineage row).
- **Only the last group defers.** A later group's expand may depend on an
  earlier contract (a table it drops and the later expand recreates; a unique
  index a later FK needs), so earlier groups — pending now or still pending in
  the ledger — contract inline, in order.
- A `contract_pending` row whose file is not on disk is logged with the
  existing "applied hash has no file" line, plus that this code never runs it.
- An adopted file (supersession) over a lineage whose contract is still pending
  inherits it: it runs its own contract and clears both rows.

## Who runs it, when

- **Serve mode only** (`getBootMode() === "serve"`), started in the database
  plugin's `onReady` (after the swap can happen; never blocks readiness), as a
  supervised `void` task whose failure is reported loudly (migrations log +
  thrown into the server-caught report path) and leaves the row pending — the
  next boot retries. The server keeps serving: the new code runs fine on the
  expanded schema.
- **Exec children** take the shared gen lock and never run a deferred contract.
- **Hosts without a cluster (PGlite)**: a single process; the driver's gen lock
  is a no-op and the deferred contract runs right after boot.
- **Test helper `runMigrations`** and the **dry run** run boot steps then every
  deferred contract in the same transaction (so `migration-applies-clean` keeps
  covering the contract, and proves the claimed data re-runs cleanly).

## Where the code goes

- `plugins/database/plugins/migrations/server/internal/runner.ts` — ledger
  column, `planSchemaSteps` split, `contract_pending` record step,
  `applyDeferredContracts(db, migrations)` (one transaction per group, timestamp
  order; re-reads the ledger under the lock, so two waiters never double-run),
  dry run + `runMigrations` run both.
- `plugins/database/server/internal/driver.ts` — `DatabaseDriverImpl` gains
  `holdSchemaGeneration(gen)` and `awaitGenerationsGone(knowing)`.
- `plugins/database/plugins/connection/server/internal/schema-generation.ts` —
  `createSchemaGenerationLocks` (beside `openListenSession`: a dedicated direct
  session), pool name `schema-generation`; each exclusive wait is bounded on the
  server by `lock_timeout` (45 s, under the 60 s client deadline) and resumes
  after a re-scan, so a dead socket is still noticed.
- `plugins/database/machine/internal/pg-driver.ts` — wires it.
- `plugins/database/plugins/pglite/server/internal/pglite-driver.ts` — no-op.
- `plugins/database/server/index.ts` + `server/internal/deferred-contract.ts` —
  take the gen lock in `onReadyBlocking` before the schema layer; run the
  deferred contract in `onReady` (exec children skip `onReady`).

## Known limits

- The first deploy of this change: the backend it replaces holds no lock.
- A later deploy's boot that finds an earlier group still pending completes it
  inline without waiting (boot must not wait on old processes); the code
  serving then already knows that group, and only a process two deploys old
  still draining could be hit.
- A schema-generation session lost mid-life (in practice a cluster restart) is
  reported, not re-taken.
- Docs: `migrations/CLAUDE.md` (phases section, ledger), `database/CLAUDE.md`
  (Bootstrap), the comment in `server/index.ts`.

## Verification

- Unit (`runner.test.ts`): plan split — pending phased file yields boot steps
  without contract + a deferred entry; a ledger `contract_pending` row yields a
  deferred entry and no boot steps; empty contract records complete; adopted
  records complete; missing file for a pending row throws.
- DB tests (throwaway DB): `migrations/check/internal/schema-layer.test.ts` —
  boot leaves the contract pending, a row the old code inserts afterwards is
  backfilled by the deferred run, the dry run rejects a non-idempotent backfill;
  `schema-generation.test.ts` — the wait ends exactly when the last older
  session goes, and old code starting meanwhile queues behind it.
- `./equin check`, `./equin test plugins/database`, `./equin build` and confirm
  the worktree backend boots and the ledger shows no pending rows.
