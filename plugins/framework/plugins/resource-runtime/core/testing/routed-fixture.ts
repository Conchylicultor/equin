/**
 * The shared routed fixture: a keyed resource declared the way a compiled
 * collection is — a minted identity route plus a membership — and a change
 * delivered the way the change feed delivers it. A keyed entry is always a
 * routed membership entry (keyed ⇒ membership ⇒ routed, a registration throw),
 * so every suite that needs "a keyed resource over a simulated table" builds it
 * here rather than hand-rolling a plan and a feed per file.
 *
 *   - `identityPlan(table, cols)` — the plan `compileWindowQuery` emits for a
 *     single-table collection: one identity route on the base table, read by
 *     every tuple as membership.
 *   - `defineRoutedTable(h, spec)` — register a keyed resource on that plan with
 *     an `alias` (unbounded window), `window` or `point` membership, and get
 *     back its handle and a `feed` for its table.
 *   - `wholeReach(tables)` — the reach plan a non-keyed value declares when it
 *     reads each of `tables` whole: one `full` route per table, every tuple
 *     reading all of them — a change to any recomputes each tracked tuple FULL.
 *   - `feedChange(h, change)` — one base-table change, as the change feed
 *     delivers it (`routeChange` → `routeTableChange`).
 *
 * A routed entry is reached ONLY through its routes, so a `readSet` the harness
 * answers for its key would be a dead option (display only):
 * `defineRoutedTable` refuses it.
 */

import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  mintReachPlan,
  mintRoutePlan,
  type ChangeSource,
  type ReachPlan,
  type RoutePlan,
} from "../routing";
import type { Resource, ResourceParams } from "../runtime";
import type { Harness } from "../test-support";

/**
 * The plan `compileWindowQuery` emits for a single-table window / point set /
 * alias: one identity route `base` on `table`, gating on `cols`, read by every
 * tuple in the membership role.
 */
export function identityPlan(
  table: string,
  cols: readonly string[] = ["id", "n"],
): RoutePlan {
  return mintRoutePlan({
    routes: [{ id: "base", table, map: { kind: "identity" }, columns: cols }],
    usesOf: () => new Map([["base", { role: "membership" as const }]]),
  });
}

/**
 * The reach plan of a non-keyed value reading each of `tables` whole: one
 * `full` route per table, read by every tuple — so a change to any of them
 * recomputes each tracked tuple (and a param-less persisted / cascading
 * entry's `{}`) FULL.
 */
export function wholeReach(tables: readonly string[]): ReachPlan {
  return mintReachPlan({
    routes: tables.map((table) => ({
      id: table,
      table,
      map: { kind: "full" as const, reason: `reads ${table} whole` },
      columns: ["id"],
    })),
    usesOf: () =>
      new Map(tables.map((t) => [t, { role: "membership" as const }])),
  });
}

/** The fields of a base-table change a test states (the rest default as the feed's). */
export interface FedChange {
  table: string;
  op: "I" | "U" | "D";
  ids: readonly string[] | null;
  xid?: string;
  changedAt?: number;
  source?: ChangeSource;
  keys?: Readonly<Record<string, readonly (string | null)[]>> | null;
  unchanged?: readonly string[] | null;
}

/** One base-table change as the change feed delivers it (`routeChange`). */
export function feedChange(h: Harness, change: FedChange): void {
  const source = change.source ?? "feed";
  h.runtime.routeTableChange({
    source,
    table: change.table,
    op: change.op,
    ids: change.ids,
    keys: change.keys ?? null,
    unchanged: change.unchanged ?? null,
    ...(change.xid !== undefined ? { xid: change.xid } : {}),
    ...(change.changedAt !== undefined ? { changedAt: change.changedAt } : {}),
  });
}

type Loader<Row> = (
  params: ResourceParams,
  ctx?: { affectedIds: readonly string[] },
) => Row[] | Promise<Row[]>;

/**
 * A `window`'s ids query and its size, stated together or not at all: a
 * suite whose `windowIdsOf` cuts a LIMIT must say how many rows a full window
 * holds, or every window reads as not full and its exits stop backfilling.
 * Omitted, the window is the FULL loader's ids, unlimited (`limitOf` =
 * `Infinity`) — the suite's FULL loader then cuts no LIMIT either.
 */
type WindowBounds =
  | { windowIdsOf?: never; limitOf?: never }
  | {
      /** `window`: the bounded ordered id list. */
      windowIdsOf: (params: ResourceParams) => Promise<string[]>;
      /**
       * `window`: the tuple's window size, the LIMIT `windowIdsOf` cuts (a
       * window holding fewer rows is not full; stated with `familyOf`, a fresh
       * tuple may be derived — see `deriveSub`).
       */
      limitOf: (params: ResourceParams) => number;
    };

export type RoutedTableSpec<Row> = RoutedTableFields<Row> & WindowBounds;

interface RoutedTableFields<Row> {
  key: string;
  /** The base table the identity route names. */
  table: string;
  /**
   * `alias` — the unbounded window (`scopedMembership`, the only shape L2
   * persists); `window` — a bounded ordered window; `point` — an explicit id
   * set per tuple.
   */
  membership: "alias" | "window" | "point";
  /** The FULL read (no ctx) and the scoped refill (ctx: only those rows). */
  loader: Loader<Row>;
  /** `alias`: the ordered id list. Default: the FULL loader's ids, in order. */
  orderOf?: (params: ResourceParams) => Promise<string[]>;
  /**
   * `alias` / `window`: the order signature of one row. The alias requires one
   * (a routed alias always knows its ORDER BY); the default `() => ""` says the
   * order never moves in place.
   */
  orderSignatureOf?: (row: unknown, params: ResourceParams) => string;
  /** `window`: the tuple's derivation family (the query it is a range of). */
  familyOf?: (params: ResourceParams) => string;
  /** `point`: the tuple's id set. Default: `params.ids`, comma-separated. */
  idsOf?: (params: ResourceParams) => readonly string[];
  /** Default: `identityPlan(table)`. */
  plan?: RoutePlan;
  /** Default: an array of anything (the suites assert on frames, not parses). */
  schema?: ZodParser<Row[]>;
  /** Default: `row.id`. */
  keyOf?: (row: unknown) => string;
  preload?: "boot" | "boot-and-keep";
  debounceMs?: number;
}

export interface RoutedTable<Row> {
  resource: Resource<Row[], ResourceParams>;
  /** One change to this table, delivered as the change feed does (`feedChange`). */
  feed: (
    op: "I" | "U" | "D",
    ids: readonly string[] | null,
    o?: Omit<FedChange, "table" | "op" | "ids">,
  ) => void;
}

const defaultKeyOf = (row: unknown): string => (row as { id: string }).id;

/** Register a keyed resource over `spec.table` the way a compiled collection is. */
export function defineRoutedTable<Row>(
  h: Harness,
  spec: RoutedTableSpec<Row>,
): RoutedTable<Row> {
  const readSet = h.readSetOf(spec.key);
  if (readSet.length > 0) {
    throw new Error(
      `defineRoutedTable("${spec.key}"): the harness answers a readSet for it (${readSet.join(", ")}) — a routed entry is reached only through its routes, so drop the readSet`,
    );
  }
  const keyOf = spec.keyOf ?? defaultKeyOf;
  const fullIds = async (params: ResourceParams): Promise<string[]> =>
    (await spec.loader(params)).map(keyOf);
  const scope =
    spec.membership === "alias"
      ? {
          scopedMembership: {
            orderOf: spec.orderOf ?? fullIds,
            orderSignatureOf: spec.orderSignatureOf ?? (() => ""),
          },
        }
      : spec.membership === "window"
        ? {
            membership: {
              kind: "window" as const,
              ...(spec.windowIdsOf !== undefined
                ? { windowIdsOf: spec.windowIdsOf, limitOf: spec.limitOf }
                : {
                    windowIdsOf: fullIds,
                    limitOf: () => Number.POSITIVE_INFINITY,
                  }),
              ...(spec.orderSignatureOf !== undefined
                ? { orderSignatureOf: spec.orderSignatureOf }
                : {}),
              ...(spec.familyOf !== undefined
                ? { familyOf: spec.familyOf }
                : {}),
            },
          }
        : {
            membership: {
              kind: "point" as const,
              idsOf:
                spec.idsOf ??
                ((p: ResourceParams) => (p.ids ? p.ids.split(",") : [])),
            },
          };
  const resource = h.runtime.defineResource<Row[], ResourceParams>(
    {
      key: spec.key,
      schema:
        spec.schema ?? (z.array(z.unknown()) as unknown as ZodParser<Row[]>),
      keyed: { keyOf },
      validateParams: () => {},
      ...(spec.preload !== undefined ? { preload: spec.preload } : {}),
    },
    {
      routes: spec.plan ?? identityPlan(spec.table),
      ...scope,
      loader: spec.loader,
      ...(spec.debounceMs !== undefined ? { debounceMs: spec.debounceMs } : {}),
    },
  );
  return {
    resource,
    feed: (op, ids, o = {}) =>
      feedChange(h, { ...o, table: spec.table, op, ids }),
  };
}
