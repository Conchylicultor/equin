import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { SCHEMA_LAYER_STATE_TABLE } from "@plugins/database/plugins/derived-views/core";
import { compiledDerivedViews } from "@plugins/database/plugins/derived-views/server";
import { getViewConfig } from "drizzle-orm/pg-core";
import type { SchemaOwner } from "@plugins/framework/plugins/server-core/core";
import type { Migration, SchemaLayerInputs } from "./runner";

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

// ── The schema layer's stamp ─────────────────────────────────────────────────
//
// Only a database's owner — its serving backend — runs the boot schema layer
// (server-core's `core/schema-role.ts`). An `exec` child booted out of the same
// checkout checks instead that the owner already committed the layer FOR ITS
// CODE: the owner records this stamp once its boot DDL committed, and the
// child compares it with the stamp of its own code — one row read, no lock
// beyond the row's table's ACCESS SHARE, no catalog walk.
//
// The stamp is a pure function of everything the layer installs from source:
// the migration files (their names and content hashes) and every derived input
// (`SchemaLayerInputs`), each `SchemaStampPart` included: what a plugin that
// installs boot DDL of its own contributes (see "Boot DDL outside the layer"
// below). `inputDigests` below answers one digest per key of that type, so an
// input added to the layer without a digest here is a tsc error — the stamp
// cannot silently miss what the layer installs. What the layer does from DATA
// (each rollup's reconcile, which heals drift) is the owner's alone and is not
// part of the stamp: nothing a child could compare.
//
// Equal stamps mean the database holds exactly the schema this code was
// written against. A different stamp means it does not — usually the ~26 s
// between a push advancing main's checkout and main's new backend booting —
// and the child refuses to run rather than running DDL itself.

// ── Boot DDL outside the layer ───────────────────────────────────────────────
//
// Four plugins install boot DDL in their own `onReadyBlocking`, after the
// layer. The owner records the stamp at its `onReady`, once that DDL has
// committed, but the stamp digests only what a part names. So the question for
// each owner is this: when a deploy changes only its install, can an exec child
// of the NEW code, admitted during the deploy window, break against the OLD
// install? Its writes look like the old backend's: that backend keeps serving
// and writing through the same install until the new one boots.
//
// - The job queue's schema (graphile-worker, `infra/jobs`): UNSAFE, so it is a
//   part. A child runs no worker, but it enqueues. Through the library's own
//   helpers (`addJob`, `completeJobs`, `rescheduleJobs`), that is SQL the NEW
//   library writes against the OLD queue schema's functions and tables. A
//   graphile bump that changes those functions makes the child's enqueue fail.
//   Its digest is the library's version: a bump with no schema change costs
//   children only the wait for the new backend.
// - Change-feed's triggers (`network/live/change-feed`): safe. A child opens
//   no LISTEN and only writes. Its writes fire the triggers the serving backend
//   installed, which route the old layouts for the old backend, exactly like
//   that backend's own writes. A table only the new code feeds gets no NOTIFY
//   from a child's write in the window, but no backend serves it yet, and the
//   new backend loads it fresh once its triggers exist.
// - Table-mirror's sets (`database/table-mirror/source`): safe. A child's
//   writes go to the change log through the installed triggers, as the old
//   backend's do. A table added to a set has no log trigger yet, but the
//   reader that serves the set is the old backend's and refuses that table
//   (`unknown-table`). The table's first pull is the new backend's full copy,
//   taken after its triggers exist, so it sees every row the child wrote.
// - live-state-snapshot's L2 tables: safe. A child runs no L2 init, so no
//   persist hook is installed: it neither reads nor writes those tables.
//
// The table-mirror and change-feed trigger SQL (and graphile's superseded-row
// trigger) is also not in the stamp. When it changes, a child's write fires the
// old version, as the old backend's writes do, and the new owner reinstalls it
// at boot.

/** Each input's digest: a pure function of the declarations, never of the database. */
type InputDigests = {
  readonly [K in keyof SchemaLayerInputs]-?: string;
};

const inputDigests = ({
  views,
  derivedTables,
  updatedAtSpecs,
  triggers,
  claimedTriggerSets,
  stampParts,
}: SchemaLayerInputs): InputDigests => ({
  // The compiled `CREATE VIEW`s in dependency order: what `rebuildDerivedViews`
  // installs. (Its read aliases follow from these and the migrated tables.)
  // Every list is put in a canonical order first: contributions arrive in
  // load-wave order, which differs between two processes booting one code.
  views: compiledDerivedViews(
    [...views].sort((a, b) =>
      getViewConfig(a.view).name.localeCompare(getViewConfig(b.view).name),
    ),
  )
    .map((v) => `${v.name}\n${v.ddl}`)
    .join("\n--\n"),
  // Each rollup's definition: its table's DDL, columns and every source's
  // maintain function and triggers. `handle` is the drizzle read handle, a
  // view of `table`/`columns` already digested.
  derivedTables: dataJson(
    [...derivedTables]
      .sort((a, b) => a.table.localeCompare(b.table))
      .map(({ handle: _handle, ...definition }) => definition),
    "derivedTables",
  ),
  updatedAtSpecs: dataJson(
    byId(updatedAtSpecs.map((s) => s.triggerSet)),
    "updatedAtSpecs",
  ),
  triggers: dataJson(byId(triggers), "triggers"),
  claimedTriggerSets: dataJson(
    [...claimedTriggerSets].sort(),
    "claimedTriggerSets",
  ),
  // What boot DDL OUTSIDE the layer requires (`SchemaStampPart`): the queue
  // schema's library version, for one. The owner records the stamp only once
  // that DDL has committed too, at its `onReady`.
  stampParts: dataJson(byId(stampParts), "stampParts"),
});

function byId<T extends { readonly id: string }>(sets: readonly T[]): T[] {
  return [...sets].sort((a, b) => a.id.localeCompare(b.id));
}

/** One digest per part of the layer: the migrations, then each derived input. */
type StampParts = { readonly migrations: string } & InputDigests;

const StoredStamp = z.record(z.string(), z.string());

/**
 * The stamp of the schema layer `migrations` + `inputs` install. Pure: the
 * owner writes it after committing the layer, a verifier computes it from its
 * own code and compares.
 *
 * NOTE for a boot that collects only part of the graph (a job booted on its
 * plugin closure, task-1794734812-18qcur): `inputs` must then be the WHOLE
 * app's, from a build-time artifact — a stamp of a partial graph never equals
 * the owner's, and the child would always be refused (loudly, never wrongly
 * admitted).
 */
export function schemaLayerStamp(
  migrations: readonly Migration[],
  inputs: SchemaLayerInputs,
): string {
  const digests: StampParts = {
    migrations: migrations.map((m) => `${m.file} ${m.hash}`).join("\n"),
    ...inputDigests(inputs),
  };
  // Stored as each part's hash, by part, so a mismatch says WHICH part of the
  // layer differs (a pending migration, a view edit) rather than only that one does.
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(digests)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, digest]) => [key, sha256Hex(digest).slice(0, 16)]),
    ),
  );
}

/** The parts two stamps disagree on, by name. */
export function differingParts(stored: string, expected: string): string[] {
  const want = StoredStamp.parse(JSON.parse(expected));
  let have: Record<string, string>;
  try {
    have = StoredStamp.parse(JSON.parse(stored));
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof z.ZodError))
      throw err;
    return ["(a stamp in another format)"];
  }
  const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
  return [...keys].filter((k) => want[k] !== have[k]).sort();
}

/**
 * A declaration as JSON, keys sorted. Functions are left out — in these
 * declarations they are asserts (`beforeInstall`) or the reconcile's SQL
 * builders, never DDL. Anything that is not plain data (a class instance, a
 * drizzle object) throws, naming where: a digest that stringified it would
 * either miss what it holds or fold in what it does not mean.
 */
function dataJson(value: unknown, path: string): string {
  return JSON.stringify(plain(value, path));
}

function plain(value: unknown, path: string): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || typeof value === "symbol") {
      throw new Error(`[schema-stamp] ${path}: a ${typeof value} is not data`);
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((v, i) => plain(v, `${path}[${i}]`));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `[schema-stamp] ${path}: not plain data (${(value as object).constructor?.name ?? "an object with a prototype"}) — digest the DDL it stands for instead`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    // `_`-prefixed keys are the framework's own marks on a collected
    // contribution (`_pluginId`, `_pluginDescription`, `_doc`): who declared
    // it and how it reads, never what it installs — a reworded plugin
    // description must not hold every child back for a deploy.
    if (key.startsWith("_")) continue;
    if (v === undefined || typeof v === "function") continue;
    out[key] = plain(v, `${path}.${key}`);
  }
  return out;
}

/**
 * The channel the owner NOTIFYs, with the stamp as payload, when it records
 * its stamp — what a verifier waiting for its schema LISTENs on (database's
 * `awaitSchemaLayer`). Delivered at commit.
 */
export const SCHEMA_STAMPED_CHANNEL = "schema_layer_stamped";

export const STATE = drizzleSql.raw(`"public"."${SCHEMA_LAYER_STATE_TABLE}"`);

/**
 * Record `stamp` (its boot layer's `SchemaLayerResult.stamp`) as the code the
 * owner set the schema up for, and NOTIFY the verifiers waiting on it.
 *
 * Once the owner's WHOLE boot DDL committed — the barrier's end, i.e. its
 * `onReady` — not inside the layer: the change feed's triggers, the mirror's
 * and the queue schema are installed by later hooks, and a child admitted at
 * the layer's commit would write a new table before its feed trigger existed.
 * By the boot only, never the deferred contract's later run: a newer owner may
 * have recorded its own stamp in between. Writes only when it changed.
 */
export async function recordSchemaLayerStamp(
  db: NodePgDatabase,
  _owner: SchemaOwner,
  stamp: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await writeStamp(tx, stamp);
  });
}

async function writeStamp(tx: Tx, stamp: string): Promise<void> {
  // Derived-layer bookkeeping like `derived_view_state`, so created here and
  // not by a migration; a fork copies the row with the schema it describes.
  await tx.execute(
    drizzleSql.raw(
      `CREATE TABLE IF NOT EXISTS "public"."${SCHEMA_LAYER_STATE_TABLE}" (
         id boolean PRIMARY KEY DEFAULT true CHECK (id),
         stamp text NOT NULL,
         written_at timestamptz NOT NULL DEFAULT now()
       )`,
    ),
  );
  await tx.execute(
    // sql-writes:hand-written — imperative schema_layer_state table, no typed handle (debt)
    drizzleSql`
      INSERT INTO ${STATE} (id, stamp, written_at)
      VALUES (true, ${stamp}, now())
      ON CONFLICT (id) DO UPDATE SET stamp = EXCLUDED.stamp, written_at = now()
      WHERE ${STATE}.stamp IS DISTINCT FROM EXCLUDED.stamp
    `,
  );
  await tx.execute(
    drizzleSql`SELECT pg_notify(${SCHEMA_STAMPED_CHANNEL}, ${stamp})`,
  );
}
