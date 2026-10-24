import { runMigrations as runGraphileMigrations } from "graphile-worker";
import {
  BOOT_DDL_QUERY_DEADLINE_MS,
  createDbPool,
  withQueryDeadline,
} from "@plugins/database/plugins/connection/server";
import { installSupersededTrigger } from "./superseded-trigger";

// ── Who installs the queue schema, and who merely asserts it ─────────────────
//
// The queue schema is a property of the DATABASE, not of whoever happens to
// enqueue first.
//
// Installation used to be a SIDE EFFECT of the first `makeWorkerUtils()` call
// (`worker.ts`'s `getWorkerUtils`), which meant the invariant held from
// "whenever the first non-transactional enqueue landed" rather than from boot —
// and never at all for a process that only ever enqueues inside somebody else's
// transaction, which writes on the caller's own connection and reaches no
// graphile helper. This file is that installation, made explicit and callable:
// the jobs plugin runs it at `onReadyBlocking`, and a test that provisions a
// throwaway database calls it directly.
//
// WHICH DATABASES ACTUALLY NEED IT. A worktree database does not: the fork
// keeps graphile's migration watermark (`ExcludeSchemaDataFromFork({ schema:
// "graphile_worker", keep: ["migrations"] })` in `../index.ts`) while emptying
// the rows that describe main's queue, so a fork is born with a schema graphile
// already considers installed and the call below is one connect and one
// `SELECT`. What still needs it is a database that never had the schema at all
// — main's very first boot, a `createTestDb` throwaway — and a graphile version
// bump whose new migrations must be applied.
//
// Installation is owned by whoever provisions or boots the database. `enqueue`
// only ASSERTS — see `registry.ts`'s tx transport. The tempting unification
// ("just install at the top of `enqueue`") is rejected in the design doc
// (`research/2026-08-20-jobs-queue-schema-is-a-property-of-the-database.md`):
// the connection string names THIS process's app database while `opts.tx` may
// be a transaction on any database, so it would install the schema in one place
// and write in another, and on a fresh database it would run graphile's whole
// migration chain inside the caller's open transaction, holding their row locks
// `idle in transaction` for the duration. A rung-4 assert dressed as a rung-1
// fix.

/** The one schema name this file and its error speak about. */
const QUEUE_SCHEMA = "graphile_worker";

/** Postgres `invalid_schema_name` — what a statement raises when it references
 * a schema that does not exist. */
const UNDEFINED_SCHEMA = "3F000";

/**
 * Install (or bring up to date) graphile-worker's own schema on the database
 * `connectionString` names, plus this plugin's superseded-row trigger on
 * graphile's job table. Idempotent: graphile records its migration watermark in
 * the schema itself and the trigger carries its own definition signature, so on
 * an already-installed database this is one connect plus two catalog reads.
 *
 * Deliberately NOT memoized. A `Map` keyed by connection string would grow once
 * per worktree ever forked and never shrink, to save a round trip on a path
 * that runs at most once per boot; callers that need a once-per-process gate
 * (a test harness opening many scenarios) own that gate themselves, where they
 * also own the lifetime of the database it is about.
 */
export async function installQueueSchema(
  connectionString: string,
): Promise<void> {
  // We own the pool rather than handing graphile the connection string, and
  // that is deliberate. Graphile's own `connectionString` branch builds a pool
  // and pushes a releaser that calls `pgPool.end()` WITHOUT returning the
  // promise (`dist/lib.js:190-199`), so the close floats: `runMigrations`
  // resolves while the connection may still be closing. A database with a
  // lingering connection cannot be `ALTER DATABASE … RENAME`d, which is exactly
  // what the fork path does after provisioning. Owning the pool means our
  // `await pool.end()` below is the real, awaited close.
  //
  // Built by `createDbPool` (`jobs-schema`), so connecting and every statement
  // carry a deadline. The one exception to the awaited close: a connection lost
  // to a missed deadline is abandoned, never closed (its fd may already be
  // someone else's), so `pool.end()` resolves without closing it — and the
  // install rejects with `QueryDeadlineExceededError` first, so no caller goes
  // on to rename that database believing it idle.
  const pool = createDbPool({ name: "jobs-schema", connectionString, max: 1 });
  try {
    // graphile's migrations and the trigger install are boot DDL: on a graphile
    // version bump they take ACCESS EXCLUSIVE locks on the queue tables and can
    // legitimately wait minutes behind the previous backend's workers during a
    // hot-swap. They get the boot-DDL bound, not the 60 s default.
    await withQueryDeadline(
      {
        ms: BOOT_DDL_QUERY_DEADLINE_MS,
        reason:
          "job-queue schema install (graphile migrations + superseded trigger) may wait on the previous backend's queue locks",
      },
      async () => {
        await runGraphileMigrations({ pgPool: pool });
        // Ours, not graphile's, and installed HERE because this is the one place
        // every database gets its queue schema — main's boot, a graphile version
        // bump, and every `createTestDb` throwaway. It has to follow the
        // migrations, which create the table it hangs off. A no-op (catalog read
        // only, no table lock) once installed; see `superseded-trigger.ts`.
        const client = await pool.connect();
        try {
          await installSupersededTrigger(client);
        } finally {
          client.release();
        }
      },
    );
  } finally {
    await pool.end();
  }
}

/**
 * Thrown when a job row is written on a connection whose database has no queue
 * schema — a database that has never hosted a booted backend and was not forked
 * from one. A named class rather than a message convention, so callers (and the
 * regression suite) assert `instanceof` and the wording below stays free to
 * change.
 *
 * The message carries only what is known WITHOUT a query, on purpose. See
 * `registry.ts`'s tx transport: the failure it wraps has already aborted the
 * caller's transaction, so asking the same client which database it is on would
 * raise `25P02` instead of answering.
 */
export class QueueSchemaMissingError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      `[jobs] this transaction is on a database whose \`${QUEUE_SCHEMA}\` schema is not installed, ` +
        `so the job row has nowhere to land. That schema is installed when a backend boots against ` +
        `a database, and inherited by any database forked from one — so this is a database that has ` +
        `had neither. Run \`./equin build\` for a worktree, or call ` +
        `\`installQueueSchema(connectionString)\` for a throwaway test database.`,
      options,
    );
    this.name = "QueueSchemaMissingError";
  }
}

/**
 * Is `err` Postgres refusing a statement because the queue schema is absent?
 *
 * Both halves matter: the SQLSTATE alone would also match a typo naming some
 * other schema, and the name alone would match an unrelated error that merely
 * mentions it. Lives here, beside the error it mints, so the one place that
 * knows the schema's name is the one place that knows what its absence looks
 * like.
 */
function isMissingQueueSchemaError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== UNDEFINED_SCHEMA) return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.includes(QUEUE_SCHEMA);
}

/**
 * Run `write` — a statement that writes a job row on a connection this plugin
 * does not own — and translate the one failure mode that means "this database
 * has no queue schema" into {@link QueueSchemaMissingError}. Every other
 * failure rethrows untouched: absorbing an unrelated error into a wrong
 * diagnosis is worse than the bare `3F000` this exists to replace.
 *
 * The translation deliberately adds NO detail from the database — no
 * `current_database()`, no `search_path` read. `3F000` aborts the caller's
 * transaction, so every later statement on that same client raises `25P02`
 * (`current transaction is aborted`) rather than answering; a "better message"
 * built that way would replace one illegible error with two.
 */
export async function withQueueSchemaAssert<T>(
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isMissingQueueSchemaError(err))
      throw new QueueSchemaMissingError({ cause: err });
    throw err;
  }
}
