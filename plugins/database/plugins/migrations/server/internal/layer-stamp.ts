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
// below). `inputItems` below answers one item map per key of that type, so an
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

// ── Itemized: one digest per declared object ────────────────────────────────
//
// Each derived part is stored as one digest PER ITEM it installs (a view by
// name, a rollup by table, a trigger set by id, …), never as one digest of the
// whole list. A process that started only some plugins (a job, server-core's
// `resolveStartSet`) holds only its own plugins' declarations: it can check
// that every object ITS code declares is installed as it declares it — the
// objects its code can reach, since a plugin's code imports the declarations
// it reads — but it cannot recompute a digest of the whole list
// (`verifySchemaLayer`'s `partial`). A whole process compares everything.
//
// What a partial check does not see: a trigger or rollup another plugin owns
// that fires on a table the job writes. When a deploy changes only such an
// item, a job admitted in the deploy window writes through the old one —
// exactly as the old backend, still serving, writes through it (the argument
// "Boot DDL outside the layer" makes above); the new owner reinstalls it at
// its boot, and a rollup's reconcile heals what it maintained.

/** One part's items: item key → its digest. */
type Items = Readonly<Record<string, string>>;

/** Each input's items: a pure function of the declarations, never of the database. */
type InputItems = {
  readonly [K in keyof SchemaLayerInputs]-?: Items;
};

const digest = (text: string): string => sha256Hex(text).slice(0, 16);

function itemsBy<T>(
  list: readonly T[],
  key: (item: T) => string,
  text: (item: T, at: string) => string,
  part: string,
): Items {
  const out: Record<string, string> = {};
  for (const item of list) {
    const k = key(item);
    if (k in out) {
      throw new Error(`[schema-stamp] ${part}: two declarations of "${k}"`);
    }
    out[k] = digest(text(item, `${part}[${k}]`));
  }
  return sorted(out);
}

function sorted(items: Record<string, string>): Items {
  return Object.fromEntries(
    Object.entries(items).sort(([a], [b]) => a.localeCompare(b)),
  );
}

const inputItems = ({
  views,
  derivedTables,
  updatedAtSpecs,
  triggers,
  claimedTriggerSets,
  stampParts,
}: SchemaLayerInputs): InputItems => ({
  // Each view's compiled `CREATE VIEW` (what `rebuildDerivedViews` installs)
  // and the views it is declared to depend on — compiled alone, so it needs
  // no other view's declaration.
  views: itemsBy(
    views,
    (v) => getViewConfig(v.view).name,
    (v) => {
      const [compiled] = compiledDerivedViews([{ view: v.view }]);
      return `${compiled!.name}\n${compiled!.ddl}\n${[...(v.dependsOn ?? [])].sort().join(",")}`;
    },
    "views",
  ),
  // Each rollup's definition: its table's DDL, columns and every source's
  // maintain function and triggers. `handle` is the drizzle read handle, a
  // view of `table`/`columns` already digested.
  derivedTables: itemsBy(
    derivedTables,
    (t) => t.table,
    ({ handle: _handle, ...definition }, at) => dataJson(definition, at),
    "derivedTables",
  ),
  updatedAtSpecs: itemsBy(
    updatedAtSpecs.map((s) => s.triggerSet),
    (t) => t.id,
    (t, at) => dataJson(t, at),
    "updatedAtSpecs",
  ),
  triggers: itemsBy(
    triggers,
    (t) => t.id,
    (t, at) => dataJson(t, at),
    "triggers",
  ),
  claimedTriggerSets: itemsBy(
    claimedTriggerSets,
    (id) => id,
    (id) => id,
    "claimedTriggerSets",
  ),
  // What boot DDL OUTSIDE the layer requires (`SchemaStampPart`): the queue
  // schema's library version, for one. The owner records the stamp only once
  // that DDL has committed too, at its `onReady`.
  stampParts: itemsBy(
    stampParts,
    (p) => p.id,
    (p, at) => dataJson(p, at),
    "stampParts",
  ),
});

/** The stamp: the migrations' digest, then each derived part's items. */
type Stamp = { readonly migrations: string } & InputItems;

const StoredStamp = z
  .object({ migrations: z.string() })
  .catchall(z.record(z.string(), z.string()));

/**
 * The stamp of the schema layer `migrations` + `inputs` install. Pure: the
 * owner writes it after committing the layer, a verifier computes it from its
 * own code and compares — whole (`differingParts`), or, in a process that
 * started only some plugins, item by item for what it holds
 * (`partialMismatches`).
 */
export function schemaLayerStamp(
  migrations: readonly Migration[],
  inputs: SchemaLayerInputs,
): string {
  const stamp: Stamp = {
    migrations: digest(migrations.map((m) => `${m.file} ${m.hash}`).join("\n")),
    ...inputItems(inputs),
  };
  // Parts in a canonical order, so equal code always gives equal text.
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(stamp).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

type ParsedStamp = z.infer<typeof StoredStamp>;

function parseStored(stored: string): ParsedStamp | null {
  try {
    return StoredStamp.parse(JSON.parse(stored));
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof z.ZodError))
      throw err;
    return null;
  }
}

/** The parts two stamps disagree on, by name (with up to three items each). */
export function differingParts(stored: string, expected: string): string[] {
  const want = StoredStamp.parse(JSON.parse(expected));
  const have = parseStored(stored);
  if (have === null) return ["(a stamp in another format)"];
  const out: string[] = [];
  if (want.migrations !== have.migrations) out.push("migrations");
  const parts = new Set([...Object.keys(want), ...Object.keys(have)]);
  parts.delete("migrations");
  for (const part of [...parts].sort()) {
    const w = (want[part] ?? {}) as Items;
    const h = (have[part] ?? {}) as Items;
    const keys = [...new Set([...Object.keys(w), ...Object.keys(h)])]
      .filter((k) => w[k] !== h[k])
      .sort();
    if (keys.length > 0) out.push(describe(part, keys));
  }
  return out;
}

/**
 * What a process that started only some plugins finds different: the
 * migrations, or any item ITS declarations hold that the stored stamp does not
 * hold as it declares it. Items only other plugins declare are not its to
 * check. Empty: the database is set up for everything this process's code
 * declares.
 */
export function partialMismatches(stored: string, own: string): string[] {
  const mine = StoredStamp.parse(JSON.parse(own));
  const have = parseStored(stored);
  if (have === null) return ["(a stamp in another format)"];
  const out: string[] = [];
  if (mine.migrations !== have.migrations) out.push("migrations");
  for (const part of Object.keys(mine).sort()) {
    if (part === "migrations") continue;
    const m = mine[part] as Items;
    const h = (have[part] ?? {}) as Items;
    const keys = Object.keys(m)
      .filter((k) => m[k] !== h[k])
      .sort();
    if (keys.length > 0) out.push(describe(part, keys));
  }
  return out;
}

function describe(part: string, keys: readonly string[]): string {
  const shown = keys.slice(0, 3).join(", ");
  return `${part} (${shown}${keys.length > 3 ? `, +${keys.length - 3}` : ""})`;
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
    // A wake-up, not the stamp: a waiter re-reads the row, and an itemized
    // stamp can exceed NOTIFY's 8000-byte payload.
    drizzleSql`SELECT pg_notify(${SCHEMA_STAMPED_CHANNEL}, ${digest(stamp)})`,
  );
}
