import { type BuildExtraConfigColumns, eq, getTableName } from "drizzle-orm";
import {
  type AnyIndexBuilder,
  type AnyPgColumn,
  index,
  type PgTable,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "@plugins/database/server";
import type { FieldsRecord } from "@plugins/fields/core";
import {
  defaultNow,
  type DefaultedKeys,
  defineEntity,
  isDbDefault,
  type Entity,
  type EntityColumns,
  type EntityMeta,
  type EntityMetaBase,
  type TouchedBy,
} from "@plugins/infra/plugins/entities/server";
import type {
  AnyExtensionShape,
  EntityExposure,
  ExtensionTimestamp,
} from "@plugins/infra/plugins/entity-extensions/core";
import type {
  ColumnRef,
  ExtensionJoin,
  ExtensionPresence,
} from "@plugins/infra/plugins/query-resource/core";
import { extensionIndexName } from "./index-names";

type ParentTable = PgTable & { id: AnyPgColumn };

// The plugin's own fields: the shape's full record minus the key and the
// timestamps, which belong to the primitive.
type OwnFields<Sh extends AnyExtensionShape> = Omit<
  Sh["fields"],
  Sh["key"] | ExtensionTimestamp
>;

// Index builders pre-bound to the DERIVED table name. The caller supplies only
// a short table-local suffix (`"block_created"`) and gets back drizzle's own
// builder, so the full expressive surface — `.on()`, `.using()`, `.where()`,
// `.desc()` — stays available. See `index-names.ts` for why the prefix is bound
// rather than authored.
export interface ExtensionIndexBuilders {
  index(suffix: string): ReturnType<typeof index>;
  uniqueIndex(suffix: string): ReturnType<typeof uniqueIndex>;
}

// Optional 4th argument to `defineExtension`: the DB-only concerns of the
// table, as in `defineEntity`'s `meta`.
export interface ExtensionMeta<Sh extends AnyExtensionShape> {
  // Per-column DDL (`default`, `name`, `references`) for the plugin's OWN
  // fields only. The key column and the timestamps are the primitive's, so
  // they cannot be declared here.
  columns?: EntityMetaBase<OwnFields<Sh>>["columns"];
  // Overrides of whether a change to one of the plugin's OWN columns moves the
  // row's derived `updatedAt` (`false`, or `{ into, outOf }` typed against the
  // column's value type). Every own column not named here counts (`true`); the
  // key and `createdAt` never do. See "updatedAt" in the entity-extensions
  // CLAUDE.md.
  touchedBy?: Partial<TouchedBy<OwnFields<Sh>>>;
  // Passthrough to pgTable's 3rd-arg callback; `t` is keyed by JS property
  // name and covers the key and the timestamps as well as the plugin's fields.
  indexes?: (
    t: BuildExtraConfigColumns<string, EntityColumns<Sh["fields"]>, "pg">,
    b: ExtensionIndexBuilders,
  ) => AnyIndexBuilder[];
}

// The columns with a DB default — optional on insert. The plugin's own
// defaulted columns come from `meta.columns` (the same derivation
// `defineEntity` uses); the timestamps always default to now().
type ExtensionDefaultedKeys<
  Sh extends AnyExtensionShape,
  M extends ExtensionMeta<Sh>,
> =
  DefaultedKeys<OwnFields<Sh>, { columns: M["columns"] }> | ExtensionTimestamp;

type ExtensionTable<F extends FieldsRecord, D extends keyof F> = Entity<
  F,
  D
>["table"];

// The handle `defineExtension` returns: an `Entity` over the extension's full
// field record `F` (key + own fields + timestamps), plus the 1:1 accessors.
// Because it IS an entity, query-resource takes it as `from:` directly.
//
// `table` is exposed so the *defining* plugin can compose richer drizzle
// queries (live-state loaders, complex SQL); cross-plugin imports of the table
// are blocked by the boundary checker because the table never leaves
// `internal/` — only the handle is barrel-exported.
export interface EntityExtension<
  K extends string,
  F extends FieldsRecord,
  D extends keyof F = never,
  S extends keyof F = never,
  E extends EntityExposure | null = EntityExposure | null,
> extends Entity<F, D, S> {
  // The parent key's name: the key column's JS property and the wire field.
  readonly key: K;
  // The fields this extension exposes to every list reaching its parent — the
  // shape's own `exposure` (same object), `null` when it exposes none.
  // `network/live`'s `LiveColumns.Expose(ext)` serves it.
  readonly exposure: E;
  // The full row, server-only columns included.
  //
  // Every accessor takes an optional executor (the pool by default): a caller
  // writing the parent row and its extension in ONE transaction passes its `tx`,
  // since the pool cannot see a parent row that transaction has not committed.
  get(
    id: string,
    exec?: DbExecutor,
  ): Promise<ExtensionTable<F, D>["$inferSelect"] | undefined>;
  // Insert the row or overwrite it: every own column without a DB default is
  // required, since the INSERT half must stand on its own (Postgres checks
  // NOT NULL on the proposed row before resolving the conflict).
  upsert(
    id: string,
    values: Omit<ExtensionTable<F, D>["$inferInsert"], K | ExtensionTimestamp>,
    exec?: DbExecutor,
  ): Promise<ExtensionTable<F, D>["$inferSelect"]>;
  // Change some columns of an EXISTING row; `undefined` when there is none
  // (nothing is inserted).
  update(
    id: string,
    patch: Partial<
      Omit<ExtensionTable<F, D>["$inferInsert"], K | ExtensionTimestamp>
    >,
    exec?: DbExecutor,
  ): Promise<ExtensionTable<F, D>["$inferSelect"] | undefined>;
  delete(id: string, exec?: DbExecutor): Promise<void>;
  // This side table as a join of its parent's collection
  // (`serveCollection(c, { from: parent, joins: [ext.join("playback")] })`):
  // LEFT, 1:1 on the parent's id, routed as an `alias` — a side row I / U / D
  // refills its host row. `alias` names it in the collection's column
  // overrides (`(j) => j.playback.lastPlayedAt`), which offer only its
  // `wireColumns` — never a server-only column (by default the timestamps).
  //
  // `on` joins it onto a RELATED host instead (`{ from: "attempt", col:
  // attempts.taskId }` — a column of an earlier join naming the parent's id):
  // LEFT on that column, routed `reverse` like a lookup (a side row's write
  // reaches the hosts whose `on` names its parent). An exposing extension's
  // join reads each exposed field's derived `absent` (its declared default,
  // else NULL) where the side row is missing, and carries its presence field.
  join<A extends string>(
    alias: A,
    opts?: { on: ColumnRef },
  ): ExtensionJoin<A, ExtensionTable<F, D>> & {
    wireColumns: Entity<F, D, S>["wireColumns"];
  };
}

// The handle type a given shape + meta produce.
type ExtensionOf<
  Sh extends AnyExtensionShape,
  M extends ExtensionMeta<Sh>,
> = EntityExtension<
  Sh["key"],
  Sh["fields"],
  ExtensionDefaultedKeys<Sh, M>,
  Sh["serverOnly"][number],
  Sh["exposure"]
>;

// Define a `<parent>_ext_<name>` 1:1 side-table from a shape
// (`defineExtensionShape`, in `core/`) and return a handle whose methods close
// over it. The parent plugin doesn't know the extension exists; the consumer
// owns the table, its live-state resource, its HTTP route, and its UI.
// Drizzle-kit discovers the underlying pgTable when the consumer re-exports
// `<handle>.table` from the same `tables*.ts` file — see the entity-extensions
// CLAUDE.md for the convention.
//
// Built on `defineEntity`: the key column is the shape's key, stored as
// `parent_id` (text PK, FK → parent.id ON DELETE CASCADE); the timestamps
// default to now(). `schema` is `shape.schema` itself, so the browser's row
// schema and the server's are one object.
//
// `const M`, as in `defineEntity`: it keeps each column meta at its literal type
// so the presence of `default` survives into `DefaultedKeys`.
export function defineExtension<
  Sh extends AnyExtensionShape,
  const M extends ExtensionMeta<Sh> = ExtensionMeta<Sh>,
>(
  parentTable: ParentTable,
  name: string,
  shape: Sh,
  meta: M = {} as M,
): ExtensionOf<Sh, M> {
  const tableName = `${getTableName(parentTable)}_ext_${name}`;
  const { key } = shape;
  const exposure = shape.exposure;
  if (exposure !== null) {
    assertExposure(exposure, tableName, getTableName(parentTable), name, meta);
  }

  const builders: ExtensionIndexBuilders = {
    index: (suffix) => index(extensionIndexName(tableName, suffix)),
    uniqueIndex: (suffix) => uniqueIndex(extensionIndexName(tableName, suffix)),
  };

  // Typed against the widened `FieldsRecord`: the precise types are restated
  // once, by the return cast below.
  const fields: FieldsRecord = shape.fields;
  // The TOTAL rule map `defineEntity` requires: the key and `createdAt` never
  // count, every own column counts unless `meta.touchedBy` overrides it — so a
  // new column counts by default and cannot be missed (over-counting is the
  // only possible error, and it is harmless).
  const overrides: Partial<TouchedBy<FieldsRecord>> = meta.touchedBy ?? {};
  const touchedBy: TouchedBy<FieldsRecord> = {};
  for (const k of Object.keys(fields)) {
    if (k === "updatedAt") continue;
    touchedBy[k] =
      k === key || k === "createdAt" ? false : (overrides[k] ?? true);
  }
  const entityMeta: EntityMeta<FieldsRecord> = {
    primaryKey: key,
    columns: {
      ...meta.columns,
      [key]: {
        name: "parent_id",
        references: {
          column: (): AnyPgColumn => parentTable.id,
          onDelete: "cascade",
          // A rewrite of the parent's ids (a legacy bare uuid gaining its
          // kind's prefix, `plugins/ids`) carries the side row along.
          onUpdate: "cascade",
        },
      },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    // Every side-table carries the primitive's `updatedAt` timestamp, derived
    // by the database trigger from `touchedBy` — never written by the app.
    updatedAt: { touchedBy },
    serverOnly: shape.serverOnly,
    // `as any` at the runtime/type boundary, as in `define-entity.ts`: the
    // precise `t` type rides in `ExtensionMeta`'s own signature.
    indexes: (t: any) => meta.indexes?.(t, builders) ?? [],
  };
  const entity = defineEntity(tableName, fields, entityMeta);

  const { table } = entity;
  const keyColumn = table[key];
  if (!keyColumn) {
    throw new Error(`defineExtension("${tableName}"): no key column "${key}".`);
  }

  // The one cast, as in `defineEntity`: the body is typed against the widened
  // `FieldsRecord`; `ExtensionOf<Sh, M>` restates the precise types the shape
  // and meta produce (the rows the methods read are that table's rows).
  return Object.freeze({
    ...entity,
    // The same object the browser imports — equal by identity, not just by
    // construction.
    schema: shape.schema,
    key,
    async get(id: string, exec: DbExecutor = db) {
      const rows = await exec
        .select()
        .from(table)
        .where(eq(keyColumn, id))
        .limit(1);
      return rows[0];
    },
    async upsert(
      id: string,
      patch: Record<string, unknown>,
      exec: DbExecutor = db,
    ) {
      // `updatedAt` is derived by the trigger, so neither side stamps it. An
      // empty patch would leave `set` empty, which drizzle rejects: rewrite the
      // key with its own value instead — a no-op the trigger ignores. (drizzle
      // drops `undefined` values, so a patch of only those is empty too.)
      const empty = Object.values(patch).every((v) => v === undefined);
      const set = empty ? { [key]: id } : patch;
      const rows = await exec
        .insert(table)
        .values({ ...patch, [key]: id })
        .onConflictDoUpdate({ target: keyColumn, set })
        .returning();
      return rows[0];
    },
    async update(
      id: string,
      patch: Record<string, unknown>,
      exec: DbExecutor = db,
    ) {
      // An empty patch: nothing to set, so just read the row back.
      const empty = Object.values(patch).every((v) => v === undefined);
      if (empty) {
        const rows = await exec
          .select()
          .from(table)
          .where(eq(keyColumn, id))
          .limit(1);
        return rows[0];
      }
      const rows = await exec
        .update(table)
        .set(patch)
        .where(eq(keyColumn, id))
        .returning();
      return rows[0];
    },
    async delete(id: string, exec: DbExecutor = db): Promise<void> {
      await exec.delete(table).where(eq(keyColumn, id));
    },
    exposure,
    join(alias: string, opts?: { on: ColumnRef }): ExtensionJoin {
      return {
        kind: "extension",
        alias,
        table,
        key: keyColumn,
        parentKey: parentTable.id,
        wireColumns: entity.wireColumns,
        ...(opts === undefined ? {} : { on: opts.on }),
        ...(exposure === null ? {} : exposureReads(exposure)),
      };
    },
  }) as unknown as ExtensionOf<Sh, M>;
}

// What an exposing extension's join reads beyond its columns: each exposed
// column field's missing-row value (`absent`, derived from the field's
// declared default — NULL reads the raw column), and the presence field read
// off the side row's existence.
function exposureReads(
  exposure: EntityExposure,
): Pick<ExtensionJoin, "absent" | "presence"> {
  const absent: Record<string, string | number | boolean | null> = {};
  const presence: Record<string, ExtensionPresence> = {};
  for (const [f, field] of Object.entries(exposure.fields)) {
    if (field.presence === null) absent[f] = field.absent;
    else presence[f] = { values: field.presence.values };
  }
  return {
    absent,
    ...(Object.keys(presence).length > 0 ? { presence } : {}),
  };
}

// An exposure names its extension by data the browser declared (`parent`,
// `name`, so `slice`), which must be THIS table — and an exposed field's
// derived `absent` (its declared default, else NULL) is what a parent with no
// side row reads in every list, so a literal DB default that disagrees would
// make "no row" and "a defaulted row" read two different values.
function assertExposure<Sh extends AnyExtensionShape>(
  exposure: EntityExposure,
  tableName: string,
  parentName: string,
  name: string,
  meta: ExtensionMeta<Sh>,
): void {
  const fail = (message: string): never => {
    throw new Error(`defineExtension("${tableName}"): ${message}`);
  };
  if (exposure.parent.name !== parentName) {
    fail(
      `its shape exposes to entity "${exposure.parent.name}", but its parent table is "${parentName}" — \`exposes.parent\` names the parent.`,
    );
  }
  if (exposure.name !== name) {
    fail(
      `its shape's \`exposes.name\` is "${exposure.name}", but it is defined as "${name}".`,
    );
  }
  if (exposure.slice !== tableName) {
    fail(
      `its exposure's slice "${exposure.slice}" is not its table name — the slice names the table it is read from.`,
    );
  }
  const columns = (meta.columns ?? {}) as Record<
    string,
    { default?: unknown } | undefined
  >;
  for (const [f, field] of Object.entries(exposure.fields)) {
    if (field.presence !== null) continue;
    const declared = columns[f]?.default;
    const literal = literalDefaultOf(declared);
    if (literal.kind === "literal" && literal.value !== field.absent) {
      fail(
        field.absent === null
          ? `exposed field "${f}" declares no default, so a missing side row reads NULL — but its column defaults to ${JSON.stringify(literal.value)}. Declare it on the field (\`{ default: ${JSON.stringify(literal.value)} }\`): a missing row and a defaulted one must read the same value.`
          : `exposed field "${f}" reads its default ${JSON.stringify(field.absent)} where the side row is missing, but its column defaults to ${JSON.stringify(literal.value)} — a missing row and a defaulted one must read the same value.`,
      );
    }
  }
}

// A column meta's `default` as a literal, when it is one (a bare value or
// `{ kind: "literal" }`); a computed default (`now`, SQL) is not.
function literalDefaultOf(
  declared: unknown,
): { kind: "literal"; value: unknown } | { kind: "none" } {
  if (declared === undefined) return { kind: "none" };
  if (isDbDefault(declared)) {
    return declared.kind === "literal"
      ? { kind: "literal", value: declared.value }
      : { kind: "none" };
  }
  return { kind: "literal", value: declared };
}
