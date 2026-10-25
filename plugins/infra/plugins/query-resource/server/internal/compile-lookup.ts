import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db as realDb, readTag } from "@plugins/database/server";
import type {
  FullRoute,
  ResourceParams,
  TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import type {
  ColumnRef,
  JoinSpec,
} from "@plugins/infra/plugins/query-resource/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { planArm } from "./arm-plan";
import { compileJoins } from "./joins";
import { BASE_ROUTE_ID, routedBase, tablePrimary } from "./routes";
import type { QueryDb, RoutedSource, SelectMap } from "./spec";

// A compiled LOOKUP: one row of a table found by its key, with the joins
// hanging off it (a conversation's attempt) — the read a hand-written value
// loader makes beside its own truth ("which checkout is this conversation
// in?"). Declared once by the plugin that owns the tables, it yields BOTH the
// query (`run`) and what the query reads (`read`, for a served value's
// `reads.lookups`), from the same point compile a collection's `:rows`
// sibling goes through (`planArm`), so the two cannot disagree:
//
// - every route's `columns` are exactly the columns its SQL may reference
//   (projection, join keys, the key column) — a write to any other column
//   is gated out by the change feed's `unchanged` set before it reaches a
//   tuple;
// - the key table's route `match`es on the key column, and each tuple's use
//   names the one key ITS params ask about (`read(keyOf)`, the consumer's own
//   decoding of its params) — a write to another row reaches no tuple, and a
//   tuple asking about none (`keyOf` null) reads nothing;
// - every route is `full`: the reader is a hand-written loader with no host
//   ids to refill, so a reached tuple recomputes whole;
// - `run`'s statement carries the lookup's READ TAG (database's `readTag`),
//   and `read` declares each of its tables covered only by reads carrying it
//   (resource-runtime's `TaggedRead`): a loader reading one of them another
//   way reads columns no route gates, so the drift guard reports it and fails
//   it open (A8 / D5). The tag is the label, minted once per process
//   (`readTag` refuses a second mint), so neither another lookup under the
//   same label nor a hand-written query can carry it.

/** A lookup's answer: the row, or none for that key. */
export type LookupResult<Row> = { found: true; row: Row } | { found: false };

// The projection field the key rides under (dropped before `row` parses).
const KEY_FIELD = "__lookup_key";

// The mark a compiled lookup puts on a read. Module-private, so a
// `LookupRead` cannot be spelled as a literal: its routes' columns gate
// updates, so only the code that renders the SQL may state them.
const COMPILED: unique symbol = Symbol("query-resource.lookup-read");

/**
 * What a compiled lookup reads for a reader keyed by `P`, for a served value's
 * `reads.lookups` (`compiledValueReach`): its routes — one `full` route per
 * relation, gated by the columns its SQL reads, the key table's matched per
 * tuple — and which of them each tuple reads. Minted by
 * `CompiledLookup.read` only.
 */
export interface LookupRead<P extends ResourceParams = ResourceParams> {
  /** The lookup's label — its read tag, and the prefix of its route ids. */
  readonly label: string;
  /** Every relation its SQL reads, as a `full` route (ids `<label>:<relation>`). */
  readonly routes: readonly FullRoute[];
  /** The routes `params` reads: none when the tuple names no key. */
  readonly usesOf: (params: P) => ReadonlyMap<string, TupleUse>;
  readonly [COMPILED]: true;
}

/** Whether `read` came from a compiled lookup (not a cast literal). */
export function isLookupRead(read: object): read is LookupRead<never> {
  return (read as Partial<LookupRead>)[COMPILED] === true;
}

export interface CompiledLookup<Row> {
  /**
   * The row `key` names (the key column's canonical text), through the
   * lookup's one tagged statement; `null` asks about no row.
   */
  run(key: string | null): Promise<LookupResult<Row>>;
  /**
   * What `run` reads, for a reader whose tuple `params` asks about the key
   * `keyOf(params)` — the same key it passes to `run` (`null`: none).
   */
  read<P extends ResourceParams>(
    keyOf: (params: P) => string | null,
  ): LookupRead<P>;
}

export interface LookupSpec<Row> {
  /**
   * The lookup's name: its read tag (letters, digits, `. _ : -`) and the
   * prefix of its route ids, so two lookups' routes never collide. Unique
   * process-wide: a second compile under a label already minted throws.
   */
  label: string;
  /** The table the key names a row of: a base table or an entity, never a view. */
  from: RoutedSource;
  /** The key column: the table's single-column primary key. */
  by: PgColumn;
  /** The relations hung off the row, N:1 (query-resource's `JoinSpec`: a lookup, an extension). */
  joins?: readonly JoinSpec[];
  /** The projection: each field a column of the base (`from: "base"`) or of a join (`from: <alias>`). */
  select: Readonly<Record<string, ColumnRef>>;
  /** The row the projection decodes to — every row `run` returns is parsed by it. */
  row: ZodParser<Row>;
  /** Test seam. Defaults to the real per-worktree drizzle `db`. */
  db?: QueryDb;
}

/**
 * Compile a lookup (see the header). Every misuse — a view, a key that is not
 * the primary key, an undeclared relation in `select`, a bad label — throws
 * HERE, at module eval.
 */
export function compileLookup<Row>(spec: LookupSpec<Row>): CompiledLookup<Row> {
  const label = `compileLookup("${spec.label}")`;
  const db: QueryDb = spec.db ?? (realDb as unknown as QueryDb);
  const base = routedBase(spec.from, label);
  if (tablePrimary(base.table) !== spec.by) {
    throw new Error(
      `${label}: \`by\` "${spec.by.name}" is not the single-column primary key of "${base.name}" — a lookup names ONE row by its key.`,
    );
  }
  const joins = spec.joins ?? [];
  // The projection rendered against its relations (A4: a column of a
  // relation the lookup does not join, or of another table, throws). The arm
  // compiles the joins again and recognises these rendered columns.
  const rendered = compileJoins(base, joins, spec.by, label);
  if (KEY_FIELD in spec.select) {
    throw new Error(`${label}: \`${KEY_FIELD}\` is the lookup's own field.`);
  }
  const select: SelectMap = {
    // The key, projected under its own name: the point plan keys its rows
    // by the base identity, never by a joined column of the same name.
    [KEY_FIELD]: spec.by,
    ...Object.fromEntries(
      Object.entries(spec.select).map(([field, ref]) => [
        field,
        rendered.render(ref),
      ]),
    ),
  };
  // The tag IS the label, claimed once the spec is known good: a label no
  // read tag may be, or one already minted (another lookup's, or a hand
  // query's), throws — so a lookup's tag is its own process-wide.
  const tag = readTag(spec.label);
  const arm = planArm<Record<string, unknown>, ResourceParams>({
    key: spec.label,
    label,
    base,
    from: spec.from,
    identity: { pk: spec.by },
    select,
    joins,
    // The read tag, ANDed into the statement: it reads no column, so the
    // routes are the untagged compile's.
    where: sql`${tag} TRUE`,
    db,
    mode: { kind: "point" },
  });

  const reason = `the lookup "${spec.label}" re-reads its reader whole: a hand-written loader has no host ids to refill`;
  const keyColumn = spec.by.name;
  const routes: FullRoute[] = arm.routes.map((route) => ({
    id: `${spec.label}:${route.id === BASE_ROUTE_ID ? base.name : route.id}`,
    table: route.table,
    map: { kind: "full", reason },
    columns: route.columns,
    // The key table's rows are told apart by their key: the change feed
    // carries it (`Route.match`), and a tuple keeps only its own.
    ...(route.id === BASE_ROUTE_ID ? { match: [keyColumn] } : {}),
  }));
  const keyRouteId = routes.find((r) => r.match !== undefined)!.id;
  const none: ReadonlyMap<string, TupleUse> = new Map();

  return {
    run: async (key) => {
      if (key === null) return { found: false };
      const rows = await arm.pointQuery({}, [key]);
      if (rows.length > 1) {
        // A primary key names one row: more is a join that fans it out.
        throw new Error(
          `${label}: ${rows.length} rows for key "${key}" — a lookup's joins must be N:1 (a lookup or an extension), never fan its row out.`,
        );
      }
      const [row] = rows;
      if (row === undefined) return { found: false };
      const { [KEY_FIELD]: _key, ...fields } = row;
      return { found: true, row: spec.row.parse(fields) };
    },
    read: <P extends ResourceParams>(
      keyOf: (params: P) => string | null,
    ): LookupRead<P> => ({
      label: spec.label,
      routes,
      usesOf: (params) => {
        const key = keyOf(params);
        if (key === null) return none;
        return new Map<string, TupleUse>(
          routes.map((r) => [
            r.id,
            r.id === keyRouteId
              ? { role: "membership", match: { [keyColumn]: new Set([key]) } }
              : { role: "membership" },
          ]),
        );
      },
      [COMPILED]: true,
    }),
  };
}
