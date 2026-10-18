import { db as realDb } from "@plugins/database/server";
import {
  defineDeferredResource,
  defineResource,
} from "@plugins/framework/plugins/server-core/core";
import type {
  KeyedMembership,
  KeyedServerResourceOptions,
  Resource,
  ResourceParams,
  ScopePolicy,
} from "@plugins/framework/plugins/resource-runtime/core";
import type {
  PointParams,
  WindowParams,
  WindowSelector,
} from "@plugins/primitives/plugins/live-state/core";
import type {
  PointQueryResourceContract,
  WindowQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";
import {
  planArm,
  type ArmPlan,
  type PointArmPlan,
  type WindowArmPlan,
} from "./arm-plan";
import type { ReadColumn } from "./joins";
import { compiledRoutePlan, routedBase } from "./routes";
import type {
  BoundedQueryResourceSpec,
  PointQueryResourceSpec,
  QueryDb,
  WindowOrderKey,
  WindowQueryResourceSpec,
} from "./spec";

// The bounded-membership (window / point) compiler for the bounded working-set
// contract (research/2026-07-18-global-bounded-working-set-resource-contract.md);
// its whole-set sibling is the `all` compiler (`./compile-alias`, a collection
// declared `liveCollection(key, { all })`). One declaration derives, per kind:
//
// - **window**: the windowed FULL loader (`where → ORDER BY (declared keys +
//   pk tiebreaker, NULLS LAST) → LIMIT`, the limit decoded from the params via
//   the descriptor codec and clamped to `maxLimit`), the Layer-2 scoped refill
//   (`where ∧ pk IN affectedIds`, no order/limit), and `windowIdsOf` (the
//   ids-only windowed query — SAME where/order/limit, so the loader and the
//   membership authority cannot drift), and `orderSignatureOf` (the canonical
//   encoding of the declared order columns' wire values — an UPDATE that moves
//   an order column re-derives the window instead of going stale), emitted as
//   `membership: { kind: "window", windowIdsOf, orderSignatureOf }`. A
//   function `orderBy` is resolved per params tuple (the rendered ORDER BY
//   memoized per canonical order). The signature is per tuple — the columns
//   THAT tuple orders by — cut from `signatureColumns`, the universe of every
//   column any tuple may sort by.
// - **point**: the loader as a scoped read over `ctx?.affectedIds ??
//   decode(params)` (an empty id set short-circuits to `[]` — a legitimately
//   empty value, no query), emitted as `membership: { kind: "point", idsOf }`
//   where `idsOf` IS the descriptor's pure `point.decode`.
//
// Both kinds are ROUTED (research/2026-09-29-global-scoped-change-routing.md):
// the scope policy is `routes` — an `identity` route on the base table plus one
// route per declared join (`./joins`) — so `routeTableChange` serves them.
// Every shape of one tuple (full, scoped, ids, point) joins exactly the
// relations its `usesOf` names (`routedReads`), read off the SQL it renders.
// Hence a base table, never a view (A1: a view has no trigger and no route can
// name it), and no cascade edges: a routed entry routes the tables it reads
// itself.
//
// The compile is two halves: `planArm` (`./arm-plan`) plans one relation set —
// its joins, projection, routes, per-tuple reads, order and the SQL each shape
// renders — and `assembleWindow` / `assemblePoint` turn that one arm into the
// loaders, the membership and the scope policy. Only this compiler assembles
// here: the union (`./compile-union-window`) and the `all` compiler
// (`./compile-alias`) share the arm's ROUTED half (`routedReads`) and render
// and assemble their own raw SQL.

/**
 * The compiled server half of a bounded resource, ready for `defineResource`.
 * Its identity table is not a field: it is the table of the routes' identity
 * route, which the runtime derives.
 */
export interface CompiledWindowQuery<Row, P extends ResourceParams> {
  serverOpts: KeyedServerResourceOptions<Row[], P> & ScopePolicy<P>;
  keyField: string;
}

type AnyWindowContract<Row, P extends WindowParams = WindowParams> =
  WindowQueryResourceContract<Row, P, never> | PointQueryResourceContract<Row>;

function guard(
  condition: unknown,
  key: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`windowQueryResource("${key}"): ${message}`);
  }
}

/**
 * What the assembler needs beyond its arms: how a row reaches the wire, how a
 * tuple's limit is decoded, and the options the runtime takes as they are.
 */
interface AssembleOuter {
  /** The declared wire encoding, applied to every row a loader returns. */
  encodeRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  debounceMs?: number;
}

interface WindowOuter<P extends ResourceParams> extends AssembleOuter {
  key: string;
  /** The subscription's decoded limit, clamped to `maxLimit`. */
  limitOf: (params: P) => number;
  /** The window's page family (`rowKey.familyOf`): a page may be derived from pages of it. */
  familyOf: (params: P) => string;
  /** How a projected field is read off an encoded row (the order signature). */
  readField: (row: Record<string, unknown>, field: string) => unknown;
  validateParams?: (params: ResourceParams) => void;
}

interface PointOuter<P extends ResourceParams> extends AssembleOuter {
  /** The tuple's id set — the membership's `idsOf`. */
  idsOf: (params: P) => string[];
}

const encoder =
  <Row>(encodeRow: AssembleOuter["encodeRow"]) =>
  (rows: Row[]): Row[] =>
    encodeRow
      ? rows.map((r) => encodeRow(r as Record<string, unknown>) as Row)
      : rows;

/**
 * The routed scope policy of an arm: its routes, each tuple's uses, and the
 * membership answer. Annotated, not cast: the `as` on `serverOpts` launders
 * the spreads and would hide a missing `ScopePolicy` arm, so the policy is
 * built as its own CHECKED value first.
 */
function scopePolicyOf<Row, P extends ResourceParams>(
  arm: ArmPlan<Row, P>,
  membership: KeyedMembership<P>,
): ScopePolicy<P> {
  return {
    routes: compiledRoutePlan<P>(
      arm.routes,
      (params) => arm.tuple(params).uses,
    ),
    membership,
    ...(arm.recomputeOn !== undefined && arm.recomputeOn.length > 0
      ? { recomputeOn: arm.recomputeOn }
      : {}),
  };
}

/**
 * The window half over its one arm (the 1-tuple type: no multi-arm caller can
 * be written, so no cross-arm signature check exists): the order signature, the
 * windowed FULL loader, the scoped refill, `windowIdsOf`, the membership and
 * the scope policy. The union window (`./compile-union-window`) and the `all`
 * compiler (`./compile-alias`) share only the arm's routed half
 * (`routedReads`) and render their own SQL.
 */
export function assembleWindow<Row, P extends ResourceParams>(
  arms: readonly [WindowArmPlan<Row, P>],
  outer: WindowOuter<P>,
): CompiledWindowQuery<Row, P> {
  const [arm] = arms;
  // Each signature column's projected field, in `signatureColumns` order.
  const fields = arm.order.signatureFields;
  const encoded = encoder<Row>(outer.encodeRow);

  // Order signature: the canonical join of the row's wire values of the columns
  // its tuple orders by (the auto pk tiebreaker is immutable, hence excluded).
  // Always emitted for the window kind — no opt-in surface: the runtime
  // compares it per refilled member row and re-derives the window (one bounded
  // `windowIdsOf`) when it moved, so an UPDATE that bumps an order column (a
  // `createdAt` resurface) reorders the wire window instead of leaving it
  // stale. Every signature column is projected (`planArm` checks) — the
  // signature is computed over the wire row the loader returns. Memoized per
  // params object (the runtime hands one per tuple); a stored and a fresh
  // signature of one tuple are always cut from the same fields.
  const readField = outer.readField;
  type SigReader = (row: Record<string, unknown>) => unknown;
  const tupleSigFields = new WeakMap<object, readonly SigReader[]>();
  const sigFieldsOf = (params: P): readonly SigReader[] => {
    let readers = tupleSigFields.get(params);
    if (readers === undefined) {
      readers = arm.order.signatureOf(params).map((part): SigReader => {
        if (part.kind === "member") {
          return (row) =>
            (row[part.valuesKey] as Record<string, unknown> | undefined)?.[
              part.alias
            ];
        }
        const field = fields[part.index]!;
        return (row) => readField(row, field);
      });
      tupleSigFields.set(params, readers);
    }
    return readers;
  };
  const orderSignatureOf = (row: unknown, params: P): string =>
    sigFieldsOf(params)
      .map(
        (read) =>
          JSON.stringify(read(row as Record<string, unknown>)) ?? "undefined",
      )
      .join("\u0000");

  // FULL loader = the windowed query — bounded by construction, so the
  // runtime's FULL branches (no snapshot, sticky-FULL, evicted-snapshot
  // self-heal) can never sweep the whole collection. The scoped refill is
  // `where ∧ cuts ∧ pk IN affectedIds`, NO order/limit — a partial refill of
  // only the changed rows (the membership diff owns placement). ONE clamped
  // limit feeds the loader AND `windowIdsOf`, so the value the clients see
  // and the membership authority can never disagree about the window size.
  const loader = async (
    params: P,
    ctx?: { affectedIds: readonly string[] },
  ): Promise<Row[]> =>
    encoded(
      arm.fold(
        await (ctx
          ? arm.scopedQuery(params, ctx.affectedIds)
          : arm.fullQuery(params, outer.limitOf(params))),
        params,
      ),
    );

  // The ids-only bounded ordered id list — the membership authority. Same
  // where/cuts/order/limit as the FULL loader, projecting ONLY the pk.
  const windowIdsOf = async (params: P): Promise<string[]> => {
    const rows = await arm.idsQuery(params, outer.limitOf(params));
    return rows.map((r) => String(r[arm.keyField]));
  };

  // `limitOf` — the same clamped limit — and the window's `familyOf` let
  // the runtime derive a fresh tuple from rows other tuples of the same query
  // hold (a paged read's split or merge).
  const membership: KeyedMembership<P> = {
    kind: "window",
    windowIdsOf,
    orderSignatureOf,
    limitOf: outer.limitOf,
    familyOf: outer.familyOf,
  };
  const scopePolicy: ScopePolicy<P> = scopePolicyOf(arm, membership);

  const serverOpts = {
    loader,
    ...scopePolicy,
    ...(outer.debounceMs != null ? { debounceMs: outer.debounceMs } : {}),
    ...(outer.validateParams !== undefined
      ? { validateParams: outer.validateParams }
      : {}),
  } as KeyedServerResourceOptions<Row[], P> & ScopePolicy<P>;
  return { serverOpts, keyField: arm.keyField };
}

/**
 * The point half over its arm: the loader as a scoped read over
 * `ctx?.affectedIds ?? idsOf(params)` (an empty id set short-circuits to `[]`
 * — a legitimately empty value, no query), and `membership: { kind: "point",
 * idsOf }` — the router intersects the changed identity ids with the point
 * set.
 */
export function assemblePoint<Row, P extends ResourceParams>(
  arms: readonly [PointArmPlan<Row, P>],
  outer: PointOuter<P>,
): CompiledWindowQuery<Row, P> {
  const [arm] = arms;
  const encoded = encoder<Row>(outer.encodeRow);
  const loader = async (
    params: P,
    ctx?: { affectedIds: readonly string[] },
  ): Promise<Row[]> => {
    const ids = ctx?.affectedIds ?? outer.idsOf(params);
    if (ids.length === 0) return [];
    return encoded(arm.fold(await arm.pointQuery(params, ids), params));
  };
  const membership: KeyedMembership<P> = {
    kind: "point",
    idsOf: (params) => outer.idsOf(params),
  };
  const scopePolicy: ScopePolicy<P> = scopePolicyOf(arm, membership);
  const serverOpts = {
    loader,
    ...scopePolicy,
    ...(outer.debounceMs != null ? { debounceMs: outer.debounceMs } : {}),
  } as KeyedServerResourceOptions<Row[], P> & ScopePolicy<P>;
  return { serverOpts, keyField: arm.keyField };
}

/**
 * Turn a bounded spec + its shared contract into the two-arg `defineResource`
 * server half. Exported separately from `windowQueryResource` (which also
 * registers) so unit tests can compile against a fake `db`. All spec-shape
 * misuse throws HERE, at module eval, so a bad declaration is a boot crash,
 * never a silent misbehavior: the spec's own guards first (kind, codec, order,
 * limits), then the arm's (`planArm`).
 */
export function compileWindowQuery<Row, P extends WindowParams | PointParams>(
  contract: AnyWindowContract<Row, P & WindowParams>,
  spec: BoundedQueryResourceSpec<P>,
): CompiledWindowQuery<Row, P> {
  const key = contract.key;
  guard(
    !(spec.window && spec.point),
    key,
    "`window` and `point` are mutually exclusive — a resource's membership is one selector kind. Split it into two resources.",
  );
  guard(
    spec.window || spec.point,
    key,
    "declare `window: { maxLimit }` or `point: { by }` — for a whole ordered set, declare the collection with `all` (`liveCollection(key, { all })`), which `compileAllCollection` compiles.",
  );

  // One boundary cast (the entities plugin precedent).
  const db: QueryDb = spec.db ?? (realDb as unknown as QueryDb);
  const label = `windowQueryResource("${key}")`;
  const base = routedBase(spec.from, label);
  const relationSet = {
    key,
    label,
    base,
    from: spec.from,
    ...(spec.select !== undefined ? { select: spec.select } : {}),
    ...(spec.joins !== undefined ? { joins: spec.joins } : {}),
    where: spec.where,
    ...(spec.whereReads !== undefined ? { whereReads: spec.whereReads } : {}),
    db,
  };
  const encodeRow =
    spec.encodeRow !== undefined ? { encodeRow: spec.encodeRow } : {};
  const debounceMs =
    spec.debounceMs != null ? { debounceMs: spec.debounceMs } : {};

  if (spec.point) {
    // Read as untyped: the point kind types every window field out, and these
    // guards are for a caller the types did not reach (a cast).
    const loose = spec as unknown as Partial<WindowQueryResourceSpec<P>>;
    const codec = (contract as PointQueryResourceContract<Row>).point;
    guard(
      codec,
      key,
      "spec declares `point` but the descriptor carries no point codec — a point resource is a `liveCollection`'s `:rows` sibling (network/live): declare the collection and serve it with `serveCollection`, which compiles `c.rows` with `point: { by }`.",
    );
    guard(
      loose.orderBy === undefined &&
        loose.signatureColumns === undefined &&
        loose.readField === undefined &&
        loose.rowKey === undefined,
      key,
      "`orderBy` / `signatureColumns` / `readField` / `rowKey` are meaningless with `point` — point sets are unordered (entrants append), so there is no order to sign, cut or key.",
    );
    guard(
      loose.families === undefined && loose.recomputeOn === undefined,
      key,
      "`families` / `recomputeOn` are window-only — a point read is by id, with no `where` or order to name a family member.",
    );
    guard(
      spec.identity?.pk === undefined || spec.identity.pk === spec.point.by,
      key,
      "`point.by` must BE the identity pk (the change-feed routes by intersecting changed identity ids with each tuple's set) — drop the redundant `identity.pk` or make them the same column.",
    );
    const arm = planArm<Row, P>({
      ...relationSet,
      identity: { pk: spec.point.by },
      mode: { kind: "point" },
    });
    return assemblePoint<Row, P>([arm], {
      // `idsOf` IS the descriptor's pure `point.decode`.
      idsOf: (params) => codec.decode(params),
      ...encodeRow,
      ...debounceMs,
    });
  }

  // Window kind.
  const win = spec as WindowQueryResourceSpec<P>;
  const codec = (contract as WindowQueryResourceContract<Row, P & WindowParams>)
    .window;
  guard(
    codec,
    key,
    "spec declares `window` but the descriptor carries no window codec — a window resource is a `liveCollection` (network/live) declared with `default` and `maxLimit`: declare it there and serve it with `serveCollection`, which compiles `c.window` with `window`.",
  );
  guard(
    win.orderBy !== undefined,
    key,
    "a bounded window REQUIRES `orderBy` — without a total order, `LIMIT n` names no stable window.",
  );
  guard(
    win.rowKey !== undefined,
    key,
    "a bounded window REQUIRES `rowKey` — every window is read as key-range pages, so each tuple may be cut and each row carries its key.",
  );
  const specMaxLimit = win.window.maxLimit;
  guard(
    specMaxLimit === undefined ||
      codec.maxLimit === undefined ||
      specMaxLimit === codec.maxLimit,
    key,
    `window.maxLimit (${specMaxLimit}) disagrees with the descriptor's maxLimit (${codec.maxLimit}) — the client's encoder and the server clamp must be one number. Declare it in one place.`,
  );
  const maxLimit = specMaxLimit ?? codec.maxLimit;
  guard(
    maxLimit !== undefined,
    key,
    "declare `window.maxLimit` on the spec or `maxLimit` on the descriptor's window codec — a window needs a clamp.",
  );
  guard(
    Number.isSafeInteger(maxLimit) && maxLimit > 0,
    key,
    `window.maxLimit must be a positive integer, got ${maxLimit}.`,
  );
  guard(
    codec.defaultLimit <= maxLimit,
    key,
    `the descriptor's defaultLimit (${codec.defaultLimit}) exceeds window.maxLimit (${maxLimit}) — the default window would be silently truncated.`,
  );

  const orderSpec = win.orderBy;
  const staticOrder: WindowOrderKey[] | undefined =
    typeof orderSpec === "function"
      ? undefined
      : Array.isArray(orderSpec)
        ? orderSpec
        : [orderSpec];
  guard(
    staticOrder || (win.signatureColumns && win.signatureColumns.length > 0),
    key,
    "a function `orderBy` REQUIRES a non-empty `signatureColumns` — the union of every column it may sort by, each projected, so an UPDATE to the columns a tuple sorts by re-derives its window.",
  );
  // The universe each tuple's order signature is cut from: the declared order
  // columns for a static order, else every column any tuple may sort by.
  const signatureColumns: ReadColumn[] =
    win.signatureColumns ?? staticOrder!.map((k) => k.col);

  const arm = planArm<Row, P>({
    ...relationSet,
    ...(win.identity !== undefined ? { identity: win.identity } : {}),
    ...(win.recomputeOn !== undefined ? { recomputeOn: win.recomputeOn } : {}),
    mode: {
      kind: "window",
      order: staticOrder
        ? { kind: "static", keys: staticOrder }
        : {
            kind: "function",
            resolve: orderSpec as (params: P) => WindowOrderKey[],
          },
      signatureColumns,
      ...(win.families !== undefined ? { families: win.families } : {}),
      rowKey: win.rowKey,
    },
  });

  // The subscription's decoded limit, clamped — ONE helper feeds the loader
  // AND `windowIdsOf`.
  const decodeLimit =
    win.window.limitOf ?? ((params: P) => codec.decode(params).limit);
  const validateParams = win.window.validateParams;
  return assembleWindow<Row, P>([arm], {
    key,
    limitOf: (params) => Math.min(decodeLimit(params), maxLimit),
    familyOf: win.rowKey.familyOf,
    readField:
      win.readField ??
      ((row: Record<string, unknown>, field: string): unknown => row[field]),
    ...(validateParams !== undefined ? { validateParams } : {}),
    ...encodeRow,
    ...debounceMs,
  });
}

/** The descriptor/keyField drift assertion every registration makes. */
function assertKeyField(
  descriptor: AnyWindowContract<unknown>,
  keyField: string,
): void {
  if (descriptor.queryPk !== keyField) {
    throw new Error(
      `windowQueryResource("${descriptor.key}"): the descriptor's pkField ` +
        `"${descriptor.queryPk}" does not match the keyField "${keyField}" ` +
        `derived from the query's identity column. The descriptor's keyOf and the ` +
        `resource's identity must key on the same field — fix the pkField passed ` +
        `to the descriptor factory, or the identity/select in the spec.`,
    );
  }
}

/**
 * `windowQueryResource` whose spec is only known at boot, once contributions
 * are collected (a collection whose columns other plugins contribute): the
 * resource registers now under its descriptor, and `specOf` compiles at
 * `bindDeferredResources` — through the same compiler and the same checks.
 */
export function deferredWindowQueryResource<
  Row,
  P extends WindowParams = WindowParams,
  S extends WindowSelector = WindowSelector,
>(
  descriptor: WindowQueryResourceContract<Row, P, S>,
  specOf: () => WindowQueryResourceSpec<P>,
): Resource<Row[], P>;
export function deferredWindowQueryResource<Row>(
  descriptor: PointQueryResourceContract<Row>,
  specOf: () => PointQueryResourceSpec<PointParams>,
): Resource<Row[], PointParams>;
export function deferredWindowQueryResource<Row>(
  descriptor: AnyWindowContract<Row>,
  specOf: () =>
    WindowQueryResourceSpec<WindowParams> | PointQueryResourceSpec<PointParams>,
): Resource<Row[], WindowParams> | Resource<Row[], PointParams> {
  return defineDeferredResource(descriptor, () => {
    const { serverOpts, keyField } = compileWindowQuery(
      descriptor,
      specOf() as BoundedQueryResourceSpec<WindowParams | PointParams>,
    );
    assertKeyField(descriptor as AnyWindowContract<unknown>, keyField);
    return serverOpts;
  });
}

/**
 * Compile a bounded spec and register the keyed resource against the shared
 * contract. Asserts the contract's `queryPk` equals the derived keyField — a
 * LOUD throw at module evaluation (boot crash) on drift. (A whole ordered set
 * is not a bounded spec: declare it `liveCollection(key, { all })`.)
 */
export function windowQueryResource<
  Row,
  P extends WindowParams = WindowParams,
  S extends WindowSelector = WindowSelector,
>(
  descriptor: WindowQueryResourceContract<Row, P, S>,
  spec: WindowQueryResourceSpec<P>,
): Resource<Row[], P>;
export function windowQueryResource<Row>(
  descriptor: PointQueryResourceContract<Row>,
  spec: PointQueryResourceSpec<PointParams>,
): Resource<Row[], PointParams>;
export function windowQueryResource<Row>(
  descriptor: AnyWindowContract<Row>,
  spec:
    WindowQueryResourceSpec<WindowParams> | PointQueryResourceSpec<PointParams>,
): Resource<Row[], WindowParams> | Resource<Row[], PointParams> {
  const { serverOpts, keyField } = compileWindowQuery(
    descriptor,
    spec as BoundedQueryResourceSpec<WindowParams | PointParams>,
  );
  assertKeyField(descriptor as AnyWindowContract<unknown>, keyField);
  return defineResource(descriptor, serverOpts);
}
