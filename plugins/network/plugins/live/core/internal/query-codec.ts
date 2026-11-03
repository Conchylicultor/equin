import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import {
  decodeFilter,
  encodeFilter,
  filterColumns,
  LIST_MAX,
  type Filter,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import {
  LIVE_GROUP_DEFAULT_LIMIT,
  type LiveCountParams,
  type LiveDecodedCountQuery,
  type LiveDecodedGroupQuery,
  type LiveDecodedQuery,
  type LiveGroupableDomain,
  type LiveGroupParams,
  type LiveOrderBy,
  type LiveWindowBounds,
  type LiveSortDirection,
  type LiveWindowParams,
} from "./query";
import { parseRowKey, type LiveCutKey } from "./row-key";
import type { LiveColumnsDeclaration } from "./live-columns";
import type { ClockForm } from "./clock";

// The window query codec. A subscription is just a params tuple, so the SAME
// logical query must always produce the SAME params: encode fills the defaults,
// canonicalizes (the filter through the filter language's `encodeFilter` —
// object sugar and trees alike) and drops every part equal to its default.
// Decode is strict: the filter through `decodeFilter` (throws unless exactly
// canonical), the rest by re-encoding and comparing — a non-canonical spelling
// can never open a second subscription for the same query, and the filterable
// whitelist is a security boundary, so nothing unknown is ever defaulted or
// dropped.
//
// Two kinds of failure, thrown differently. A DECLARATION or an ENCODE that
// fails is a programmer error in this bundle: a plain `Error`, crashing loudly.
// A DECODE that fails is a subscription whose wire params do not match the
// declaration — after a deploy, most often a tab running an older bundle: a
// `ResourceContractError`, which the resource runtime refuses as
// `contract-mismatch` before the sub registers.

export interface LiveQueryCodecSpec {
  key: string;
  /** The row field that identifies a row — the order's tiebreaker, and a cut's last element. */
  id: string;
  /** A collection's column scope: its queries may name scoped sets of that scope; `null` = none. */
  columnScope: string | null;
  /** A union collection's queries may name its arms' own columns (by wire name); any other's may not. */
  arms: boolean;
  /** The entities a collection's `exposes` reaches: its queries may name their exposed columns. */
  exposes: readonly string[];
  filterable: Filterable;
  sortable: readonly string[];
  /**
   * The collection's clock fields (`clockField`) by name: a query whose
   * `where` / `orderBy` names one carries the reader's pinned `now`, and one
   * naming none carries none.
   */
  clock: Readonly<Record<string, ClockForm>>;
  defaultOrderBy: LiveOrderBy<string>;
  defaultLimit: number;
  maxLimit: number;
}

/** A window query with its column vocabulary erased — the codec validates it at runtime. */
type AnyWindowQuery = {
  where?: object;
  orderBy?: LiveOrderBy<string>;
  limit?: number;
  columns?: readonly LiveColumnsDeclaration[];
  now?: number;
};

/** A grouping query with its column vocabulary erased — the codec validates it at runtime. */
type AnyGroupQuery = {
  groupBy: string;
  where?: object;
  limit?: number;
  columns?: readonly LiveColumnsDeclaration[];
  now?: number;
};

/** A count query with its column vocabulary erased — the codec validates it at runtime. */
type AnyCountQuery = {
  where?: object;
  columns?: readonly LiveColumnsDeclaration[];
  now?: number;
};

export interface LiveQueryCodec<C extends string, S extends string> {
  encode: (
    query?: AnyWindowQuery,
    bounds?: LiveWindowBounds,
  ) => LiveWindowParams;
  decode: (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ) => LiveDecodedQuery<S>;
  /**
   * The query a window tuple is one page of: one string for every page of it
   * (its `where` and `order`), whatever its cuts and limit — the resource
   * runtime derives a page only from pages of its family. Read off canonical
   * params (the runtime's gate decoded them), so one query has one family.
   */
  familyOf: (params: LiveWindowParams) => string;
  /** Canonical encode of a grouping query — the same `where` canonicalisation as a window. */
  encodeGroups: (query: AnyGroupQuery) => LiveGroupParams;
  /**
   * STRICT decode of a grouping query's params (throws unless exactly
   * canonical). The server passes the column sets a grouping may name (its
   * exposed ones): `groupBy` and `where` may read them.
   */
  decodeGroups: (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ) => LiveDecodedGroupQuery<C>;
  /** Canonical encode of a count query's `where` — the same canonicalisation as a window. */
  encodeCount: (query: AnyCountQuery) => LiveCountParams;
  /** STRICT decode of a count query's params (throws unless exactly canonical). */
  decodeCount: (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ) => LiveDecodedCountQuery;
  /**
   * The quantum a query pins `now` at — the finest of the clock fields its
   * `where` / `orderBy` name — or `null` when it names none (it pins nothing).
   * What a reader (`useLive`) asks before it fills `now`.
   */
  clockQuantum: (query: {
    where?: object;
    orderBy?: LiveOrderBy<string>;
  }) => number | null;
}

const PARAM_KEYS = new Set([
  "limit",
  "where",
  "order",
  "after",
  "until",
  "now",
]);
const GROUP_PARAM_KEYS = new Set(["groupBy", "limit", "where", "now"]);
const COUNT_PARAM_KEYS = new Set(["where", "now"]);
const NOW_RE = /^[1-9][0-9]*$/;

/** Keys a `where` object spells a `Filter` tree with — never filterable column names. */
export const RESERVED_COLUMNS: ReadonlySet<string> = new Set([
  "and",
  "or",
  "column",
  "op",
  "operand",
]);

const GROUPABLE_DOMAINS: ReadonlySet<string> = new Set<LiveGroupableDomain>([
  "text",
  "number",
  "boolean",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createLiveQueryCodec<C extends string, S extends string>(
  spec: LiveQueryCodecSpec,
): LiveQueryCodec<C, S> {
  const fail = (message: string): never => {
    throw new Error(`liveCollection("${spec.key}"): ${message}`);
  };
  /** A decode failure: the params do not match the declaration. */
  const reject = (message: string): never => {
    throw new ResourceContractError(
      spec.key,
      `liveCollection("${spec.key}"): ${message}`,
    );
  };

  for (const column of Object.keys(spec.filterable)) {
    if (RESERVED_COLUMNS.has(column)) {
      fail(
        `"${column}" cannot be a filterable column — a where object uses it to spell a filter tree`,
      );
    }
  }
  // A dot is how a column set's wire name reads (`<set>.<field>`), so no
  // column of the collection's own may carry one.
  for (const column of [...Object.keys(spec.filterable), ...spec.sortable]) {
    if (column.includes(".")) {
      fail(
        `"${column}" cannot be a column name — "." separates a column set's name from its field`,
      );
    }
  }

  /** The columns a query may name: the collection's own, and each handle it brings. */
  interface Declaration {
    filterable: Filterable;
    sortable: readonly string[];
  }
  const own: Declaration = {
    filterable: spec.filterable,
    sortable: spec.sortable,
  };
  const withColumns = new WeakMap<
    readonly LiveColumnsDeclaration[],
    Declaration
  >();
  const declarationOf = (
    columns: readonly LiveColumnsDeclaration[] | undefined,
  ): Declaration => {
    if (columns === undefined || columns.length === 0) return own;
    const cached = withColumns.get(columns);
    if (cached !== undefined) return cached;
    const names = new Set<string>();
    let filterable: Filterable = spec.filterable;
    const sortable: string[] = [...spec.sortable];
    for (const handle of columns) {
      const owner = handle.owner;
      switch (owner.kind) {
        case "scoped":
          if (owner.scope !== spec.columnScope) {
            fail(
              spec.columnScope === null
                ? `a query names scoped columns "${handle.name}", but the collection declares no \`columnScope\``
                : `scoped columns "${handle.name}" belong to scope "${owner.scope}", not this collection's "${spec.columnScope}"`,
            );
          }
          break;
        case "arm":
          if (!spec.arms) {
            fail(
              `a query names arm "${owner.arm}"'s columns, but the collection is not declared with \`arms\``,
            );
          }
          if (owner.collection !== spec.key) {
            fail(
              `arm columns "${handle.name}" belong to "${owner.collection}"`,
            );
          }
          break;
        case "exposed":
          // A union's arms are declared after it, in other plugins, so which
          // entities they reach is not known here: the server — which folds
          // each arm's exposures — decodes against the sets it serves, strictly.
          if (!spec.arms && !spec.exposes.includes(owner.entity)) {
            fail(
              `a query names exposed columns "${handle.name}" of entity "${owner.entity}", which the collection's \`exposes\` does not reach`,
            );
          }
          break;
        default:
          owner satisfies never;
      }
      if (names.has(handle.name)) {
        fail(`two column sets are named "${handle.name}"`);
      }
      names.add(handle.name);
      filterable = { ...filterable, ...handle.wireFilterable };
      sortable.push(...handle.wireSortable);
    }
    const decl = { filterable, sortable };
    withColumns.set(columns, decl);
    return decl;
  };

  const checkLimit = (
    limit: number,
    what: string,
    onFail: (message: string) => never = fail,
  ): number => {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      onFail(`${what} must be a positive integer, got ${limit}`);
    }
    if (limit > spec.maxLimit) {
      onFail(`${what} ${limit} exceeds maxLimit ${spec.maxLimit}`);
    }
    return limit;
  };

  // ── The pinned clock ──────────────────────────────────────────────
  // A query naming a clock field in `where` / `orderBy` is computed against
  // the reader's pinned `now`; one naming none carries none (a param that
  // changes nothing would only split one query into many tuples).
  const clockNames = (
    filter: Filter | undefined,
    orderBy: LiveOrderBy<string> | undefined,
  ): string[] => {
    const named = new Set(filterColumns(filter));
    for (const [column] of orderBy ?? []) named.add(column);
    return [...named].filter((n) => Object.hasOwn(spec.clock, n));
  };
  /** The canonical `now` param for a query reading `clocks`, or `undefined` when it reads none. */
  const nowParam = (
    clocks: readonly string[],
    now: number | undefined,
    onFail: (message: string) => never,
  ): string | undefined => {
    if (clocks.length === 0) {
      if (now !== undefined) {
        onFail(
          "`now` beside a query that names no clock field — only a query reading one is pinned",
        );
      }
      return undefined;
    }
    if (now === undefined) {
      return onFail(
        `the query names clock field "${clocks[0]}" — its reader pins \`now\` (useLive fills it; a server reader passes it)`,
      );
    }
    if (!Number.isSafeInteger(now) || now <= 0) {
      onFail(`now must be a positive epoch-ms integer, got ${now}`);
    }
    const quantum = Math.min(...clocks.map((n) => spec.clock[n]!.quantumMs));
    if (now % quantum !== 0) {
      onFail(
        `now ${now} is not floored to ${quantum} ms, the quantum of the clock fields it reads — a reader pins at the quantum, so one minute is one tuple`,
      );
    }
    return String(now);
  };
  const decodeNow = (
    raw: string | undefined,
    clocks: readonly string[],
  ): number | undefined => {
    if (raw !== undefined && !NOW_RE.test(raw)) {
      reject(
        `decode: params.now must be a canonical positive-integer string, got ${JSON.stringify(raw)}`,
      );
    }
    const now = raw === undefined ? undefined : Number(raw);
    nowParam(clocks, now, (m) => reject(`decode: ${m}`));
    return now;
  };

  // The object sugar → a Filter tree (an AND of clauses). A plain value is
  // `eq`; an object is exactly one `{ op: operand }`, a no-operand op spelled
  // `{ isEmpty: true }`. Every column / op / operand check is the filter
  // language's — this only reshapes.
  const sugarClause = (column: string, filter: unknown): Filter => {
    if (filter === null) {
      fail(
        `"${column}": an operand is never null — use { isEmpty: true } to match NULL`,
      );
    }
    if (!isPlainObject(filter)) return { column, op: "eq", operand: filter };
    const entries = Object.entries(filter);
    if (entries.length !== 1) {
      fail(
        `"${column}": a filter takes exactly one operator, got ${JSON.stringify(filter)}`,
      );
    }
    const [op, operand] = entries[0]!;
    if (op === "isEmpty" || op === "isNotEmpty") {
      if (operand !== true) {
        fail(`"${column}": ${op} is spelled { ${op}: true }`);
      }
      return { column, op } as Filter;
    }
    return { column, op, operand } as Filter;
  };

  /** Any `where` spelling → a (not yet canonical) Filter, or `undefined`. */
  const toFilter = (where: object | undefined): Filter | undefined => {
    if (where === undefined) return undefined;
    if (!isPlainObject(where)) {
      return fail(
        `where must be an object (per-column sugar) or a filter tree, got ${JSON.stringify(where)}`,
      );
    }
    const keys = Object.keys(where);
    if (keys.some((k) => RESERVED_COLUMNS.has(k))) return where as Filter;
    return {
      and: keys
        // An absent optional key: TS lets `{ status: maybeStatus }` through as undefined.
        .filter((column) => where[column] !== undefined)
        .map((column) => sugarClause(column, where[column])),
    };
  };

  const encodeWhere = (
    where: object | undefined,
    decl: Declaration = own,
  ): string | undefined => {
    const filter = toFilter(where);
    try {
      return encodeFilter(filter, decl.filterable);
    } catch (err) {
      if (err instanceof Error) fail(err.message);
      throw err;
    }
  };

  const decodeWhere = (
    json: string | undefined,
    decl: Declaration = own,
  ): Filter | undefined => {
    if (json === undefined) return undefined;
    try {
      return decodeFilter(json, decl.filterable);
    } catch (err) {
      if (err instanceof Error) reject(`decode: ${err.message}`);
      throw err;
    }
  };

  const toOrderBy = (
    raw: unknown,
    decl: Declaration = own,
    onFail: (message: string) => never = fail,
  ): LiveOrderBy<S> => {
    if (!Array.isArray(raw) || raw.length === 0) {
      onFail(
        `orderBy must be a non-empty list of [column, direction], got ${JSON.stringify(raw)}`,
      );
    }
    const seen = new Set<string>();
    return (raw as unknown[]).map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        (entry[1] !== "asc" && entry[1] !== "desc")
      ) {
        return onFail(
          `orderBy entry must be [column, "asc" | "desc"], got ${JSON.stringify(entry)}`,
        );
      }
      const [column, dir] = entry as [string, LiveSortDirection];
      if (!decl.sortable.includes(column))
        onFail(`"${column}" is not a sortable column`);
      if (seen.has(column)) onFail(`orderBy names "${column}" twice`);
      seen.add(column);
      return [column as S, dir] as const;
    });
  };

  const defaultOrderJson = JSON.stringify(toOrderBy(spec.defaultOrderBy));
  checkLimit(spec.defaultLimit, "default.limit");

  const windowParams = (
    limit: number,
    where: string | undefined,
    orderBy: LiveOrderBy<S>,
    bounds: LiveWindowBounds | undefined,
    now: string | undefined,
  ): LiveWindowParams => {
    const params: LiveWindowParams = { limit: String(limit) };
    if (where !== undefined) params.where = where;
    const order = JSON.stringify(orderBy);
    if (order !== defaultOrderJson) params.order = order;
    if (bounds?.after !== undefined) params.after = bounds.after;
    if (bounds?.until !== undefined) params.until = bounds.until;
    if (now !== undefined) params.now = now;
    return params;
  };

  // A cut is a row's `$key` as the server minted it: the canonical JSON array
  // of the order keys' exact text, then the id — unless the order already
  // names the id, whose key then is the tiebreaker (the server's key list:
  // the declared keys, plus the id when no key targets it).
  const cutArity = (orderBy: LiveOrderBy<S>): number =>
    orderBy.length + (orderBy.some(([c]) => c === spec.id) ? 0 : 1);
  const parseCut = (
    raw: string,
    orderBy: LiveOrderBy<S>,
    which: "after" | "until",
    onFail: (message: string) => never = fail,
  ): LiveCutKey => parseRowKey(raw, cutArity(orderBy), which, onFail);

  const encode = (
    query?: AnyWindowQuery,
    bounds?: LiveWindowBounds,
  ): LiveWindowParams => {
    const decl = declarationOf(query?.columns);
    const orderBy = toOrderBy(query?.orderBy ?? spec.defaultOrderBy, decl);
    // Validated here too, so a bad cut throws where it was built.
    if (bounds?.after !== undefined) parseCut(bounds.after, orderBy, "after");
    if (bounds?.until !== undefined) parseCut(bounds.until, orderBy, "until");
    return windowParams(
      checkLimit(query?.limit ?? spec.defaultLimit, "limit"),
      encodeWhere(query?.where, decl),
      orderBy,
      bounds,
      nowParam(clockNames(toFilter(query?.where), orderBy), query?.now, fail),
    );
  };

  const decode = (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ): LiveDecodedQuery<S> => {
    const decl = declarationOf(columns);
    for (const k of Object.keys(params)) {
      if (!PARAM_KEYS.has(k)) reject(`decode: unknown param "${k}"`);
    }
    const { limit, where, order, after, until, now } = params;
    if (limit === undefined || !/^[1-9][0-9]*$/.test(limit)) {
      reject(
        `decode: params.limit must be a canonical positive-integer string, got ${JSON.stringify(limit)}`,
      );
    }
    const orderBy =
      order === undefined
        ? toOrderBy(spec.defaultOrderBy)
        : toOrderBy(parseJson(order, reject), decl, reject);
    const filter = decodeWhere(where, decl);
    const pinned = decodeNow(now, clockNames(filter, orderBy));
    const decoded: LiveDecodedQuery<S> = {
      limit: checkLimit(Number(limit), "limit", reject),
      where: filter,
      orderBy,
      ...(pinned !== undefined ? { now: pinned } : {}),
      ...(after !== undefined
        ? { after: parseCut(after, orderBy, "after", reject) }
        : {}),
      ...(until !== undefined
        ? { until: parseCut(until, orderBy, "until", reject) }
        : {}),
    };
    // The filter and the cuts are already strictly canonical; this pins limit / order.
    const canonical = windowParams(
      decoded.limit,
      where,
      decoded.orderBy,
      { after, until },
      now,
    );
    if (!sameParams(canonical, params)) {
      reject(
        `decode: params are not canonical — got ${JSON.stringify(params)}, ` +
          `the canonical encoding is ${JSON.stringify(canonical)}`,
      );
    }
    return decoded;
  };

  // ── Grouping queries ───────────────────────────────────────────────
  // Same discipline as the window: canonical encode, strict decode. The group
  // limit is bounded by `LIST_MAX` rather than the collection's `maxLimit` — a
  // picked set of groups must still fit one `in` filter.

  const checkGroupLimit = (
    limit: number,
    onFail: (message: string) => never = fail,
  ): number => {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      onFail(`group limit must be a positive integer, got ${limit}`);
    }
    if (limit > LIST_MAX) {
      onFail(`group limit ${limit} exceeds ${LIST_MAX}`);
    }
    return limit;
  };
  const checkGroupBy = (
    column: unknown,
    decl: Declaration,
    onFail: (message: string) => never = fail,
  ): C => {
    if (typeof column !== "string" || !Object.hasOwn(decl.filterable, column)) {
      onFail(
        `groupBy ${JSON.stringify(column)} is not a filterable column — only a declared filterable column can be grouped on`,
      );
    }
    if (Object.hasOwn(spec.clock, column as string)) {
      onFail(
        `groupBy "${column as string}" is a clock field — its value moves with the clock, so it has no groups to count`,
      );
    }
    const domain = decl.filterable[column as string]!.domain;
    if (!GROUPABLE_DOMAINS.has(domain)) {
      onFail(
        `groupBy "${column as string}" is a ${domain} column — only text / number / boolean columns can be grouped on`,
      );
    }
    return column as C;
  };
  const groupParams = (
    groupBy: C,
    limit: number,
    where: string | undefined,
    now: string | undefined,
  ): LiveGroupParams => {
    const params: LiveGroupParams = { groupBy, limit: String(limit) };
    if (where !== undefined) params.where = where;
    if (now !== undefined) params.now = now;
    return params;
  };

  const encodeGroups = (query: AnyGroupQuery): LiveGroupParams => {
    // Typed out (`orderBy?: never`), but an untyped caller must not have its
    // order silently ignored.
    if ((query as { orderBy?: unknown }).orderBy !== undefined) {
      fail(
        "a grouping query has a fixed order (count desc, then value) — it takes no orderBy",
      );
    }
    const decl = declarationOf(query.columns);
    return groupParams(
      checkGroupBy(query.groupBy, decl),
      checkGroupLimit(query.limit ?? LIVE_GROUP_DEFAULT_LIMIT),
      encodeWhere(query.where, decl),
      nowParam(clockNames(toFilter(query.where), undefined), query.now, fail),
    );
  };

  const decodeGroups = (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ): LiveDecodedGroupQuery<C> => {
    const decl = declarationOf(columns);
    for (const k of Object.keys(params)) {
      if (!GROUP_PARAM_KEYS.has(k))
        reject(`decodeGroups: unknown param "${k}"`);
    }
    const { groupBy, limit, where, now } = params;
    if (limit === undefined || !/^[1-9][0-9]*$/.test(limit)) {
      reject(
        `decodeGroups: params.limit must be a canonical positive-integer string, got ${JSON.stringify(limit)}`,
      );
    }
    const filter = decodeWhere(where, decl);
    const pinned = decodeNow(now, clockNames(filter, undefined));
    const decoded: LiveDecodedGroupQuery<C> = {
      groupBy: checkGroupBy(groupBy, decl, reject),
      limit: checkGroupLimit(Number(limit), reject),
      where: filter,
      ...(pinned !== undefined ? { now: pinned } : {}),
    };
    const canonical = groupParams(decoded.groupBy, decoded.limit, where, now);
    if (!sameParams(canonical, params)) {
      reject(
        `decodeGroups: params are not canonical — got ${JSON.stringify(params)}, ` +
          `the canonical encoding is ${JSON.stringify(canonical)}`,
      );
    }
    return decoded;
  };

  // ── Count queries ──────────────────────────────────────────────────
  // A `where` alone, under the same discipline: the unfiltered total is `{}`.

  const countParams = (
    where: string | undefined,
    now: string | undefined,
  ): LiveCountParams => ({
    ...(where !== undefined ? { where } : {}),
    ...(now !== undefined ? { now } : {}),
  });

  const encodeCount = (query: AnyCountQuery): LiveCountParams => {
    // Typed out, but an untyped caller must not have them silently ignored.
    for (const k of ["groupBy", "orderBy", "limit"] as const) {
      if ((query as Record<string, unknown>)[k] !== undefined) {
        fail(`a count query takes a \`where\` only — got ${k}`);
      }
    }
    return countParams(
      encodeWhere(query.where, declarationOf(query.columns)),
      nowParam(clockNames(toFilter(query.where), undefined), query.now, fail),
    );
  };

  const decodeCount = (
    params: Record<string, string>,
    columns?: readonly LiveColumnsDeclaration[],
  ): LiveDecodedCountQuery => {
    for (const k of Object.keys(params)) {
      if (!COUNT_PARAM_KEYS.has(k)) reject(`decodeCount: unknown param "${k}"`);
    }
    const filter = decodeWhere(params.where, declarationOf(columns));
    const pinned = decodeNow(params.now, clockNames(filter, undefined));
    const decoded: LiveDecodedCountQuery = {
      where: filter,
      ...(pinned !== undefined ? { now: pinned } : {}),
    };
    if (!sameParams(countParams(params.where, params.now), params)) {
      reject(
        `decodeCount: params are not canonical — got ${JSON.stringify(params)}`,
      );
    }
    return decoded;
  };

  const clockQuantum = (query: {
    where?: object;
    orderBy?: LiveOrderBy<string>;
  }): number | null => {
    const clocks = clockNames(toFilter(query.where), query.orderBy);
    return clocks.length === 0
      ? null
      : Math.min(...clocks.map((n) => spec.clock[n]!.quantumMs));
  };

  return {
    encode,
    decode,
    clockQuantum,
    // A pin is part of the query: within one, keys and cuts are a pure
    // function of the params; a re-pin is a new family (its pages reload).
    familyOf: (params) =>
      JSON.stringify([
        params.where ?? null,
        params.order ?? null,
        ...(params.now !== undefined ? [params.now] : []),
      ]),
    encodeGroups,
    decodeGroups,
    encodeCount,
    decodeCount,
  };
}

function parseJson(raw: string, reject: (m: string) => never): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return reject(`decode: invalid JSON ${JSON.stringify(raw)}`);
  }
}

function sameParams(
  a: LiveWindowParams | LiveGroupParams | LiveCountParams,
  b: Record<string, string>,
): boolean {
  const keys = Object.keys(b);
  return (
    keys.length === Object.keys(a).length &&
    keys.every((k) => (a as Record<string, string | undefined>)[k] === b[k])
  );
}
