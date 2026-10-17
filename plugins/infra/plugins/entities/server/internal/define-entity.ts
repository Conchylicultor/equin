import { resolveFieldStorage } from "@plugins/fields/plugins/server-capabilities/server";
import {
  wireSchema,
  type EntityRef,
} from "@plugins/infra/plugins/entities/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { pgTable, primaryKey, type PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { snakeCase } from "./snake-case";
import {
  compileFromTable,
  registerDerivedUpdatedAt,
  type DerivedUpdatedAtSpec,
  type TouchRule,
} from "@plugins/database/plugins/derived-updated-at/server";
import type {
  ColumnDefault,
  DefaultedKeys,
  Entity,
  EntityColumns,
  EntityMeta,
  EntityMetaBase,
  GeneratedKeys,
  ServerOnlyKeys,
  UpdatedAtMeta,
} from "./types";
import { isDbDefault } from "./types";

// Split a raw field schema into (is the column nullable, the schema for its
// VALUES). ONE result because the two answers must agree: a decoding storage
// arm is handed the value schema, and a column declared nullable while its
// decoder still holds the `.nullable()` wrapper is exactly the drift this
// exists to prevent — a decoder never sees `null` in either direction
// (`sql-column/CLAUDE.md`), so handing it the wrapper would make every real
// value fail one half of the round trip.
//
// Read from the RAW `field.schema` (before `fieldsToZodObject` wraps it with
// `.default()`), so wire and column nullability can never drift either. The
// unwrap loops because `.optional().nullable()` nests — the same set
// `isNullableSchema` recognised, now peeled to the bottom.
function splitNullability(schema: z.ZodTypeAny): {
  nullable: boolean;
  value: z.ZodTypeAny;
} {
  let value = schema;
  let nullable = false;
  while (value instanceof z.ZodOptional || value instanceof z.ZodNullable) {
    nullable = true;
    value = value.unwrap() as z.ZodTypeAny;
  }
  return { nullable, value };
}

// Apply an opt-in DB-column default. Bare value = `{ kind: "literal" }` sugar.
// `b` is the `as any` builder (see assembly loop) so the chain methods are
// reachable; `defaultRandom`/`defaultNow` only exist on uuid/timestamp builders
// and throw loudly at runtime if mis-targeted (guarded below).
function applyDefault(b: any, def: ColumnDefault<unknown>, key: string): any {
  if (!isDbDefault(def)) return b.default(def); // bare value sugar
  switch (def.kind) {
    case "now":
      if (typeof b.defaultNow !== "function") {
        throw new Error(
          `defineEntity: column "${key}" uses defaultNow() but its storage ` +
            `builder has no .defaultNow() (valid only for date/timestamp fields).`,
        );
      }
      return b.defaultNow();
    case "random":
      if (typeof b.defaultRandom !== "function") {
        throw new Error(
          `defineEntity: column "${key}" uses defaultRandom() but its storage ` +
            `builder has no .defaultRandom() (valid only for uuid fields).`,
        );
      }
      return b.defaultRandom();
    case "sql":
      return b.default(def.sql);
    case "literal":
      return b.default(def.value);
  }
}

// Derive a Drizzle `pgTable` AND a zod wire schema from ONE `FieldsRecord`, so
// `entity.table.$inferSelect` is identical by construction to
// `z.infer<entity.schema>`. See the Stage C plan for the full derivation.
// `const M` infers the `meta` literally. Without it, a bare string-literal
// default on a union-typed (enum-branded) field — `{ default: "starting" }`
// where the field value is `"starting" | "working" | …` — is contextually typed
// against `ColumnDefault<union>` and TS widens the WHOLE `columns` object to the
// `EntityMeta.columns` constraint shape (optional `default?`), collapsing
// `DefaultedKeys` to `never` (every DB-defaulted column wrongly becomes required
// on insert). `const` keeps each column meta at its narrow literal type so the
// presence of `default` survives. (A non-enum default — bool / plain text — never
// triggered the collapse, which is why slow_ops never caught it.)
//
// Two overloads per spelling: `meta` may be omitted only when the record has
// no `updatedAt` field — one that has it must declare `meta.updatedAt` (see
// `EntityMeta`).
//
// The ref spelling — `defineEntity(ref, meta)` — builds the table FROM the
// entity's browser-safe ref (`entityRef(name, fields)`, entities/core): its
// name is the table's, its record the columns, so the fields a browser list
// reads off the ref and the table the server reads are one declaration.
//
// A column only the server may see (a supervisor's `pid`, an SSH key, a dedup
// key) is NOT on the ref — the ref is what the browser reads, so a field there
// is one a list could `pick`. It is declared beside the ref instead:
// `defineEntity(ref, serverFields, meta)`. Those fields are columns of the
// table and absent from the wire schema / `wireColumns` (`serverOnly`, derived
// — so `meta.serverOnly` has no spelling on a ref: a ref field is a wire field).
export function defineEntity<
  F extends FieldsRecord,
  const M extends EntityMeta<F> & { serverOnly?: never } = EntityMeta<F> & {
    serverOnly?: never;
  },
>(
  ref: EntityRef<string, F>,
  meta: M,
): Entity<F, DefaultedKeys<F, M>, never, GeneratedKeys<F, M>>;
export function defineEntity<F extends FieldsRecord & { updatedAt?: never }>(
  ref: EntityRef<string, F>,
): Entity<F>;
export function defineEntity<
  F extends FieldsRecord,
  const SF extends FieldsRecord,
  const M extends EntityMeta<F & SF> & { serverOnly?: never } = EntityMeta<
    F & SF
  > & { serverOnly?: never },
>(
  ref: EntityRef<string, F>,
  serverFields: SF,
  meta: M,
): Entity<
  F & SF,
  DefaultedKeys<F & SF, M>,
  keyof SF & string,
  GeneratedKeys<F & SF, M>
>;
export function defineEntity<
  F extends FieldsRecord,
  const M extends EntityMeta<F> = EntityMeta<F>,
>(
  name: string,
  fields: F,
  meta: M,
): Entity<F, DefaultedKeys<F, M>, ServerOnlyKeys<F, M>, GeneratedKeys<F, M>>;
export function defineEntity<F extends FieldsRecord & { updatedAt?: never }>(
  name: string,
  fields: F,
): Entity<F>;
// The implementation is typed loosely (`object` in, `unknown` out) so every
// overload is compatible with it; the overloads are the contract.
export function defineEntity(
  nameOrRef: string | EntityRef,
  fieldsOrMeta?: object,
  maybeMeta?: object,
): unknown {
  if (typeof nameOrRef !== "string" && nameOrRef?.kind !== "entity") {
    throw new Error(
      "defineEntity: the first argument is the table name or an EntityRef (`entityRef(name, fields)`).",
    );
  }
  const name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
  // The ref spelling's optional middle argument: the server-only fields.
  const serverFields =
    typeof nameOrRef !== "string" && maybeMeta !== undefined
      ? (fieldsOrMeta as FieldsRecord)
      : undefined;
  const fields = (
    typeof nameOrRef === "string"
      ? fieldsOrMeta
      : { ...nameOrRef.fields, ...serverFields }
  ) as FieldsRecord;
  const rawMeta =
    (typeof nameOrRef === "string" || serverFields !== undefined
      ? maybeMeta
      : fieldsOrMeta) ?? {};
  const declared = rawMeta as EntityMetaBase<FieldsRecord> & {
    updatedAt?: UpdatedAtMeta<FieldsRecord>;
  };
  if (typeof nameOrRef !== "string" && declared.serverOnly !== undefined) {
    throw new Error(
      `defineEntity("${name}"): a ref's fields are its wire fields — declare a ` +
        `server-only column as a server field (\`defineEntity(ref, serverFields, meta)\`), not in meta.serverOnly.`,
    );
  }
  for (const key of Object.keys(serverFields ?? {})) {
    if (Object.hasOwn((nameOrRef as EntityRef).fields, key)) {
      throw new Error(
        `defineEntity("${name}"): server field "${key}" is also a field of the ref.`,
      );
    }
  }
  const meta =
    serverFields === undefined
      ? declared
      : { ...declared, serverOnly: Object.keys(serverFields) };
  const builders: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(fields)) {
    const storage = resolveFieldStorage(field.type.id);
    if (!storage) {
      throw new Error(
        `defineEntity("${name}"): field "${key}" has type "${field.type.id}" ` +
          `with no fields.storage contribution — no DB column mapping. ` +
          `Contribute Fields.Storage({ type, build }) — or ({ type, decode }) ` +
          `for a type whose column is narrowed by the field's own schema — ` +
          `for this type.`,
      );
    }

    const columnName = meta.columns?.[key]?.name ?? snakeCase(key);
    const { nullable, value } = splitNullability(field.schema);
    // The storage contribution picks its own arm: a fixed column holds exactly
    // what the type declares, a decoding one is narrowed by THIS field's schema
    // and so must be handed it (the value schema — never the `.nullable()`
    // wrapper; see `splitNullability`).
    //
    // One `as any` at the runtime/type boundary: `PgColumnBuilderBase` doesn't
    // surface the chain methods. The precise type rides in the cast below
    // (entity-extensions sets the `as unknown as` precedent).
    let b = (
      storage.build
        ? storage.build(columnName)
        : storage.decode(columnName, value)
    ) as any;

    if (!nullable) b = b.notNull();
    if (meta.primaryKey === key) b = b.primaryKey();

    const colMeta = meta.columns?.[key];
    if (colMeta?.generated) {
      if ("default" in colMeta) {
        throw new Error(
          `defineEntity("${name}"): column "${key}" is generated, so it cannot ` +
            `also declare a default.`,
        );
      }
      b = b.generatedAlwaysAs(colMeta.generated);
    }
    if (colMeta && "default" in colMeta) {
      b = applyDefault(b, colMeta.default as ColumnDefault<unknown>, key);
    }

    // Opt-in FK: lazy column thunk + onDelete/onUpdate, faithfully forwarded to
    // drizzle's native `.references(thunk, actions)`. Omitted actions fall back
    // to drizzle's NO ACTION default (Postgres's own default). FKs affect only
    // the DDL, never the row type — hence absent from `EntityColumns`.
    if (colMeta?.references) {
      const { column, onDelete, onUpdate } = colMeta.references;
      b = b.references(column, { onDelete, onUpdate });
    }

    builders[key] = b;
  }

  // Third-arg callback: composite PK (when `primaryKey` is an array) + the
  // index passthrough. `t` is keyed by JS property name.
  const extraConfig = (t: any) => [
    ...(Array.isArray(meta.primaryKey)
      ? [
          primaryKey({
            // map() widens to any[]; drizzle wants a non-empty tuple.
            columns: meta.primaryKey.map((k) => t[k]) as [any, ...any[]],
          }),
        ]
      : []),
    ...(meta.indexes?.(t) ?? []),
  ];

  // The one load-bearing cast: the loosely-assembled map is fed as
  // `EntityColumns`, and the overload signatures above restate it as the precise
  // `Entity<F, DefaultedKeys<F, M>, …>`, so `pgTable`'s own `BuildColumns`
  // infers the exact select type AND marks DB-defaulted columns optional on
  // insert (the `D` brand). `extraConfig` is `as any` because `t` was loosened
  // above.
  //
  // The cast now RE-STATES what the builders already produced, for every column
  // in every entity — there is no arm left that asserts:
  //  - a column from a DECODING arm (`text`, so every `enumTextField` union;
  //    `json` / `tags`, so every `jsonField<T>` shape) already has exactly this
  //    type — its builder was typed `StorageColumnFor<V>` off the schema that
  //    really decodes it, on every read and every write.
  //  - a column from a fixed `build` arm holding exactly its token's type
  //    (bool / int / float / date / uuid / rank) is likewise re-stated.
  //
  // The jsonb tier closed in
  // `research/2026-08-26-global-decoded-jsonb-entity-columns.md`: the cost of a
  // zod parse tracks the SCHEMA's depth, not the payload's size, so the opt-in
  // dial that tier seemed to need is the schema itself.
  const table = pgTable(
    name,
    builders as unknown as EntityColumns<FieldsRecord>,
    extraConfig,
  );

  // ─── Server-only columns ──────────────────────────────────────────────────
  // Keys present in the table DDL above but OMITTED from the wire schema and the
  // loader's select-map. The column-builder loop is untouched, so the DDL is
  // byte-identical — `serverOnly` is purely a wire-projection concern.
  const serverOnly = new Set<string>(meta.serverOnly ?? []);
  for (const key of serverOnly) {
    if (!(key in fields)) {
      throw new Error(
        `defineEntity("${name}"): serverOnly key "${key}" is not a field.`,
      );
    }
    if (
      meta.primaryKey === key ||
      (Array.isArray(meta.primaryKey) && meta.primaryKey.includes(key))
    ) {
      throw new Error(
        `defineEntity("${name}"): primary-key column "${key}" cannot be serverOnly.`,
      );
    }
  }

  // Wire schema omits the server-only keys — built via the SAME `wireSchema`
  // helper the browser calls, so `entity.schema` and a browser-side
  // `wireSchema(fields, SERVER_ONLY)` are equal by construction.
  const schema = wireSchema(fields, meta.serverOnly ?? []);

  // The loader's select-map: table columns minus the server-only keys, so the
  // server-only data is never even fetched (cannot leak).
  const wireKeys = Object.keys(fields).filter((k) => !serverOnly.has(k));
  const wireColumns = Object.fromEntries(
    wireKeys.map((k) => [k, (table as Record<string, unknown>)[k]]),
  );

  // The implementation returns `unknown`: inside this body `wireSchema` /
  // `wireColumns` are typed against the widened server-only set, not the
  // caller's literal `serverOnly`. The overloads' return type
  // `ServerOnlyKeys<F, M>` is the contract consumers see — at a concrete call
  // site it resolves to the exact server-only keys, so `entity.schema` /
  // `entity.wireColumns` carry the precise omitted types.
  const derivedUpdatedAt = compileEntityUpdatedAt(name, fields, meta, table);
  if (derivedUpdatedAt) registerDerivedUpdatedAt(derivedUpdatedAt);

  return Object.freeze({
    name,
    table,
    schema,
    wireColumns,
    derivedUpdatedAt,
  });
}

// The derived-`updatedAt` spec for this entity, or `undefined` when it has none
// (no `updatedAt` field). The types make the declaration
// required and total; these runtime checks back them for callers typed against
// the widened `FieldsRecord` (entity-extensions), which the types cannot see.
function compileEntityUpdatedAt(
  name: string,
  fields: FieldsRecord,
  meta: { updatedAt?: UpdatedAtMeta<FieldsRecord> },
  table: PgTable,
): DerivedUpdatedAtSpec | undefined {
  const decl = meta.updatedAt;
  if (!("updatedAt" in fields)) {
    if (decl !== undefined) {
      throw new Error(
        `defineEntity("${name}"): meta.updatedAt is declared but the entity ` +
          `has no updatedAt field.`,
      );
    }
    return undefined;
  }
  if (decl === undefined) {
    throw new Error(
      `defineEntity("${name}"): the entity has an updatedAt field, so ` +
        `meta.updatedAt must declare how it moves ({ touchedBy }).`,
    );
  }
  // One compiler path with `deriveUpdatedAt`: physical names and SQL types are
  // read off the built table, and the totality backstop is compileFromTable's.
  return compileFromTable(
    table,
    decl.touchedBy as Readonly<Record<string, TouchRule<unknown>>>,
    `defineEntity("${name}"): meta.updatedAt.touchedBy`,
  );
}
