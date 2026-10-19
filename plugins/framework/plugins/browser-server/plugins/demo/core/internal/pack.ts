import type {
  BrowserServe,
  BrowserServed,
} from "@plugins/framework/plugins/browser-server/core";
import type {
  ExternalAllCollection,
  ExternalLookupCollection,
  ExternalSourceRow,
  ExternalWindowCollection,
  LiveDecodedCountQuery,
  LiveDecodedQuery,
  LivePlainValue,
  LiveQuery,
  LiveQueryValue,
} from "@plugins/network/plugins/live/core";
import { LIVE_COLUMNS_KEY } from "@plugins/network/plugins/live/core";
import {
  canonicalJson,
  canonicalParams,
} from "@plugins/packages/plugins/canonical-params/core";

// A demo pack: recorded answers to the live declarations a demo reads, served
// through a browser server's own `s.serveValue` / `s.serveCollection` (the
// external arm), so the unchanged app reads them through `useLive`. Every
// answer is parsed with its declaration's schema when the pack loads, and is
// looked up by the exact tuple the client subscribes — anything else is a loud
// `DemoMissingError`. Design: research/2026-10-14-global-demo-scope-and-pack.md §1.

// ── Errors ─────────────────────────────────────────────────────────────

/** A pack entry that does not match its declaration — thrown while the pack loads, so a stale pack cannot half-render. */
export class DemoPackError extends Error {
  readonly key: string;
  readonly tuple: string;
  constructor(key: string, tuple: string, detail: string) {
    super(`demo pack: "${key}" ${tuple}: ${detail}`);
    this.name = "DemoPackError";
    this.key = key;
    this.tuple = tuple;
  }
}

/** A read of a tuple the pack did not record (the browser server answers it `loader-failed`). */
export class DemoMissingError extends Error {
  readonly key: string;
  readonly params: unknown;
  constructor(key: string, params: unknown) {
    super(
      `demo pack: "${key}" has no recorded answer for ${describe(params)}.`,
    );
    this.name = "DemoMissingError";
    this.key = key;
    this.params = params;
  }
}

function describe(params: unknown): string {
  try {
    return JSON.stringify(params) ?? String(params);
  } catch (err) {
    if (err instanceof TypeError) return String(params);
    throw err;
  }
}

// ── Entries ────────────────────────────────────────────────────────────

declare const packEntryBrand: unique symbol;

/** One recorded answer, made by `packValue` / `packAll` / `packRows` / `packWindow`. Opaque. */
export interface PackEntry {
  readonly [packEntryBrand]: true;
}

interface ParseResult {
  success: boolean;
  data?: unknown;
  error?: { issues: { path: (string | number)[]; message: string }[] };
}
interface Parser {
  safeParse(v: unknown): ParseResult;
}

/** A value declaration, erased. */
interface AnyValue {
  key: string;
  schema: Parser;
  optionalParams?: readonly string[];
  origin?: string;
  keyed?: unknown;
  query?: { encode(q: unknown): { q: string } };
  snapshot?: true;
}

/** A collection declaration, erased — the fields the pack reads. */
interface AnyCollection {
  key: string;
  id: string;
  row: Parser;
  all?: { all: { orderBy: readonly (readonly [string, "asc" | "desc"])[] } };
  window?: {
    window: {
      encode(query: object): Record<string, string>;
    };
  };
  count?: {
    count: { encode(q: { where?: object }): Record<string, string> };
  } | null;
  sortable?: readonly string[];
  contributed?: boolean;
  columnScope?: string | null;
  arms?: unknown;
  exposes?: unknown;
}

type Row = Record<string, unknown>;

type Entry =
  | { kind: "value"; decl: AnyValue; tuple: string; data: unknown }
  | { kind: "all"; decl: AnyCollection; rows: Row[] }
  | { kind: "rows"; decl: AnyCollection; rows: Row[] }
  | {
      kind: "window";
      decl: AnyCollection;
      tuple: string;
      rows: Row[];
      /** The count tuple and total, when the collection declares `count: true`. */
      count: { tuple: string; n: number } | null;
    };

const entry = (e: Entry): PackEntry => e as unknown as PackEntry;

function issueOf(r: ParseResult): string {
  const issue = r.error?.issues[0];
  return `field "${issue?.path.join(".") ?? "?"}" — ${issue?.message ?? "invalid"}`;
}

/**
 * Each row parsed with the collection's row schema, its id a string. An
 * exposing collection's rows are recorded WITHOUT `$columns` (the external
 * arm folds the exposures served on its host — none — itself), so each is
 * parsed with the empty fold and served without it.
 */
function parseRows(
  decl: AnyCollection,
  tuple: string,
  rows: readonly unknown[],
): Row[] {
  refuseFolded(decl);
  const folds = (decl.exposes ?? null) !== null;
  return rows.map((row, i) => {
    if (
      folds &&
      typeof row === "object" &&
      row !== null &&
      LIVE_COLUMNS_KEY in row
    ) {
      throw new DemoPackError(
        decl.key,
        tuple,
        `row ${i} carries "${LIVE_COLUMNS_KEY}" — an exposing collection's columns are folded by the host from the exposures it serves, never recorded.`,
      );
    }
    const r = decl.row.safeParse(
      folds && typeof row === "object" && row !== null
        ? { ...row, [LIVE_COLUMNS_KEY]: {} }
        : row,
    );
    if (!r.success) {
      throw new DemoPackError(decl.key, tuple, `row ${i}: ${issueOf(r)}.`);
    }
    const parsed = r.data as Row;
    if (folds) delete parsed[LIVE_COLUMNS_KEY];
    if (typeof parsed[decl.id] !== "string") {
      throw new DemoPackError(
        decl.key,
        tuple,
        `row ${i}: the id "${decl.id}" is ${describe(parsed[decl.id])}, not a string.`,
      );
    }
    return parsed;
  });
}

/**
 * A collection whose rows fold Postgres columns per tuple has no external
 * spelling (`serveCollectionOn` refuses it): a union's builder types exclude
 * it; a `columnScope` one, which no type tells apart, is refused here, while
 * the pack loads.
 */
function refuseFolded(decl: AnyCollection): void {
  const why =
    (decl.arms ?? null) !== null
      ? "a union collection (`arms`)"
      : decl.contributed === true
        ? "a `contributed: true` collection"
        : (decl.columnScope ?? null) !== null
          ? "a `columnScope` collection"
          : null;
  if (why !== null) {
    throw new DemoPackError(
      decl.key,
      "(declaration)",
      `${why} folds Postgres-served columns — it has no external spelling, so a pack cannot serve it.`,
    );
  }
}

// ── Builders (typed against the declaration) ───────────────────────────

/**
 * A value's answer at one tuple: its params (a typed-query value: its
 * question), exactly as a reader passes them to `useLive`.
 */
export function packValue<T, Q, QIn>(
  value: LiveQueryValue<T, Q, QIn, "worktree">,
  query: NoInfer<QIn>,
  data: NoInfer<T>,
): PackEntry;
export function packValue<T, P extends Record<string, string>>(
  value: LivePlainValue<T, P, "worktree">,
  params: NoInfer<P>,
  data: NoInfer<T>,
): PackEntry;
export function packValue(
  value: object,
  params: unknown,
  data: unknown,
): PackEntry {
  const decl = value as AnyValue;
  const declared = `(declaration)`;
  if (decl.keyed !== undefined) {
    throw new DemoPackError(
      decl.key,
      declared,
      "a paged value has no pack spelling — record its items as a collection's rows, or add a paged builder.",
    );
  }
  if (decl.origin === "central") {
    throw new DemoPackError(
      decl.key,
      declared,
      "a central value is read over the central channel, which a browser server does not host.",
    );
  }
  const tuple = recording(decl.key, params, () =>
    decl.query !== undefined
      ? valueTupleOfQuestion(decl.query.encode(params).q)
      : valueTupleOfParams(decl, params as Record<string, string>),
  );
  const r = decl.schema.safeParse(data);
  if (!r.success) {
    throw new DemoPackError(decl.key, tuple, `the value: ${issueOf(r)}.`);
  }
  return entry({ kind: "value", decl, tuple, data: r.data });
}

/** Spell a recorded tuple; a declaration's codec refusing it is the pack's error, naming the key and what was recorded. */
function recording(
  key: string,
  recorded: unknown,
  spell: () => string,
): string {
  try {
    return spell();
  } catch (err) {
    if (err instanceof Error && !(err instanceof DemoPackError)) {
      throw new DemoPackError(key, describe(recorded), err.message);
    }
    throw err;
  }
}

/** A param'd value's tuple: its canonical params, spelled one way. */
function valueTupleOfParams(
  decl: AnyValue,
  params: Record<string, string>,
): string {
  return canonicalJson(canonicalParams(params, decl.optionalParams));
}

/** A typed-query value's tuple: its question's canonical `q` (the codec's own spelling). */
function valueTupleOfQuestion(q: string): string {
  return canonicalJson({ q });
}

/** Every row of a collection declared `all` (its `key`, and its `:rows`). Any order: the pack orders them. */
export function packAll<Row>(
  collection: ExternalAllCollection<Row>,
  rows: readonly ExternalSourceRow<NoInfer<Row>>[],
): PackEntry {
  const decl = collection as unknown as AnyCollection;
  return entry({ kind: "all", decl, rows: parseRows(decl, "(all)", rows) });
}

/** Rows a collection's `:rows` answers by id — on a lookup-only collection, its one answer. */
export function packRows<Row>(
  collection: ExternalLookupCollection<Row>,
  rows: readonly ExternalSourceRow<NoInfer<Row>>[],
): PackEntry;
export function packRows<Row>(
  collection: ExternalAllCollection<Row>,
  rows: readonly ExternalSourceRow<NoInfer<Row>>[],
): PackEntry;
export function packRows<Row, F, S extends string, Cn>(
  collection: ExternalWindowCollection<Row, F, S, Cn>,
  rows: readonly ExternalSourceRow<NoInfer<Row>>[],
): PackEntry;
export function packRows(
  collection: object,
  rows: readonly unknown[],
): PackEntry {
  const decl = collection as AnyCollection;
  return entry({ kind: "rows", decl, rows: parseRows(decl, "(rows)", rows) });
}

/** `count` on a window entry exactly when the collection is declared `count: true`. */
export type PackWindowOptions<Cn> = [Cn] extends [null]
  ? { count?: never }
  : {
      /** The window's total (`useLive(c, { count: true, where })`); default: how many rows the entry lists. */
      count?: number;
    };

/**
 * A window's answer: every row matching `query`'s `where`, in any order (the
 * pack orders them by `query`'s order). It answers every tuple of that query —
 * any `limit` (the first `limit` rows) and any page cut; its rows also answer
 * `:rows`, and — declared `count: true` — its total answers `:count` at its `where`.
 */
export function packWindow<Row, F, S extends string, Cn>(
  collection: ExternalWindowCollection<Row, F, S, Cn>,
  query: Omit<LiveQuery<NoInfer<F>, NoInfer<S>>, "columns">,
  rows: readonly ExternalSourceRow<NoInfer<Row>>[],
  opts?: PackWindowOptions<Cn>,
): PackEntry {
  const decl = collection as unknown as AnyCollection;
  refuseFolded(decl);
  const tuple = recording(decl.key, query, () => windowTuple(decl, query));
  const parsed = parseRows(decl, tuple, rows);
  const count = (opts as { count?: number } | undefined)?.count;
  let total: { tuple: string; n: number } | null = null;
  if (decl.count !== null && decl.count !== undefined) {
    const n = count ?? parsed.length;
    if (!Number.isSafeInteger(n) || n < parsed.length) {
      throw new DemoPackError(
        decl.key,
        tuple,
        `count ${describe(n)} is not a total of at least the ${parsed.length} rows listed.`,
      );
    }
    total = { tuple: countTuple(decl, query.where), n };
  } else if (count !== undefined) {
    throw new DemoPackError(
      decl.key,
      tuple,
      "`count` given, but the collection is not declared `count: true`.",
    );
  }
  for (const s of decl.sortable ?? []) {
    // Every order field's `$key` text is derived from its value: refuse,
    // while the pack loads, a value with no generic text.
    for (const row of parsed) keyTextOf(decl, tuple, s, row[s]);
  }
  return entry({ kind: "window", decl, tuple, rows: parsed, count: total });
}

/**
 * The tuple a window query is: the window codec's canonical wire params minus
 * `limit` and the page cuts — the spelling every page of the query shares.
 * The loader re-encodes the decoded query it is handed the same way.
 */
function windowTuple(decl: AnyCollection, query: object): string {
  const codec = decl.window!.window;
  const params: Record<string, string> = {
    ...codec.encode({ ...query, limit: undefined }),
  };
  delete params.limit;
  return canonicalJson(params);
}

/** A total's tuple: the count codec's canonical params for `where`. */
function countTuple(decl: AnyCollection, where: object | undefined): string {
  return canonicalJson(
    decl.count!.count.encode(where === undefined ? {} : { where }),
  );
}

// ── Order and `$key` text ─────────────────────────────────────────────

/** An order-preserving text for a finite number: its float64 bits, sign-flipped, as 16 hex digits. */
function numberKeyText(n: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n === 0 ? 0 : n); // -0 sorts as 0
  let hi = view.getUint32(0);
  let lo = view.getUint32(4);
  if ((hi & 0x80000000) !== 0) {
    hi = ~hi >>> 0;
    lo = ~lo >>> 0;
  } else {
    hi = (hi | 0x80000000) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * The exact text a sortable field's value sorts by — the `keyText` the pack
 * hands `serveCollection` for every sortable field, so its code-point order
 * is the value's order: text as is, an instant's ISO string, a number's
 * order-preserving bits, a boolean's name (`false` < `true`), a value object
 * by its text wire form (`toJSON()`, a `Rank`'s key), NULL as NULL.
 * Anything else has no order text: a `DemoPackError`.
 */
function keyTextOf(
  decl: AnyCollection,
  tuple: string,
  field: string,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return numberKeyText(value);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  // A value object whose wire form is text (a `Rank`: its fractional-index
  // key) sorts by that text — the `::text` a table's `$key` is cut on.
  const json = (value as { toJSON?: () => unknown }).toJSON?.();
  if (typeof json === "string") return json;
  throw new DemoPackError(
    decl.key,
    tuple,
    `sortable field "${field}" holds ${describe(value)}, which has no order text.`,
  );
}

type KeyParts = readonly (string | null)[];

/** Two strings by code point (the cluster's `C` collation, and the live order). */
function compareCodePoints(x: string, y: string): number {
  if (x === y) return 0;
  const xs = x[Symbol.iterator]();
  const ys = y[Symbol.iterator]();
  for (;;) {
    const a = xs.next();
    const b = ys.next();
    if (a.done) return b.done ? 0 : -1;
    if (b.done) return 1;
    if (a.value !== b.value) {
      return a.value.codePointAt(0)! < b.value.codePointAt(0)! ? -1 : 1;
    }
  }
}

/** Part by part, each in its direction, a NULL last either way — the live key order. */
function compareParts(
  a: KeyParts,
  b: KeyParts,
  dirs: readonly ("asc" | "desc")[],
): number {
  for (let i = 0; i < dirs.length; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = compareCodePoints(x, y);
    return dirs[i] === "desc" ? -c : c;
  }
  return 0;
}

/** An order over a collection's rows: each row's key (the order's parts, then the id unless named) and the directions. */
function orderOf(
  decl: AnyCollection,
  tuple: string,
  orderBy: readonly (readonly [string, "asc" | "desc"])[],
): {
  keyOf: (row: Row) => KeyParts;
  dirs: ("asc" | "desc")[];
} {
  const named = orderBy.some(([c]) => c === decl.id);
  return {
    keyOf: (row) => [
      ...orderBy.map(([c]) =>
        c === decl.id
          ? (row[decl.id] as string)
          : keyTextOf(decl, tuple, c, row[c]),
      ),
      ...(named ? [] : [row[decl.id] as string]),
    ],
    dirs: [...orderBy.map(([, d]) => d), ...(named ? [] : (["asc"] as const))],
  };
}

function sortRows(
  rows: readonly Row[],
  keyOf: (row: Row) => KeyParts,
  dirs: readonly ("asc" | "desc")[],
): { row: Row; key: KeyParts }[] {
  return rows
    .map((row) => ({ row, key: keyOf(row) }))
    .sort((a, b) => compareParts(a.key, b.key, dirs));
}

// ── The pack ───────────────────────────────────────────────────────────

/** What a pack's thunk is handed when it is evaluated. */
export interface DemoPackContext {
  /** The ISO instant `ms` before the pack was loaded. */
  ago(ms: number): string;
}

declare const demoPackBrand: unique symbol;

/** A pack: its entries, evaluated (and parsed) by `servePack`. */
export interface DemoPack {
  readonly [demoPackBrand]: true;
}

interface PackThunk {
  build: (ctx: DemoPackContext) => readonly PackEntry[];
}

/**
 * Declare a pack — lazily: nothing is evaluated until `servePack` loads it,
 * so `ago` is relative to load time, and a pack module costs nothing to import.
 *
 * ```ts
 * export default definePack(({ ago }) => [
 *   packValue(configValues, { path: "x/y.jsonc" }, { … }),
 *   packAll(taskTracks, [...rows]),
 *   packRows(conversationsById, [...rows]),
 *   packWindow(conversationsGone, { where: { … } }, [...rows], { count: 12 }),
 * ]);
 * ```
 */
export function definePack(
  build: (ctx: DemoPackContext) => readonly PackEntry[],
): DemoPack {
  const thunk: PackThunk = { build };
  return thunk as unknown as DemoPack;
}

/**
 * A demo: the app it shows, the route it opens at, and its pack, loaded on
 * demand. Declared by the app's owner (`apps/<app>/plugins/demo`), so nothing
 * generic names a scenario.
 */
export interface DemoScenario {
  id: string;
  /** The `Apps.App` id the demo renders (an `<AppEmbed app>`). */
  app: string;
  /** The app-relative route it opens at (`/c/<id>`). */
  route: string;
  pack: () => Promise<{ default: DemoPack }>;
  /**
   * The scenario's browser host: a Web Worker running real server code on an
   * in-browser database (`import("@browser-host/<plugin path>")`). The keys it
   * serves are answered by it; every other key by the pack and the
   * `Demo.Resource` backends. Absent: the page answers everything.
   */
  host?: () => Promise<{ start(): Worker }>;
}

export interface ServePackOptions {
  /** The instant `ago` counts back from. Default: now. */
  now?: Date;
}

/** The `serve` half a browser server takes, erased: each call is checked by its builder. */
interface ErasedServe {
  serveValue(value: unknown, opts: unknown): BrowserServed;
  serveCollection(collection: unknown, opts: unknown): BrowserServed;
}

const CHANGES = { fixed: { reason: "demo pack" } } as const;

/**
 * Load `pack` — evaluate it with `ago`, parse every answer (a mismatch throws
 * `DemoPackError` here) — and return the browser server's `serve` half: one
 * `s.serveValue` / `s.serveCollection` per declaration the pack records,
 * `changes: { fixed: { reason: "demo pack" } }`. Each answers exactly its
 * recorded tuples; any other throws `DemoMissingError`.
 */
export function servePack(
  pack: DemoPack,
  opts: ServePackOptions = {},
): (s: BrowserServe) => BrowserServed[] {
  const now = (opts.now ?? new Date()).getTime();
  const ctx: DemoPackContext = {
    ago: (ms) => new Date(now - ms).toISOString(),
  };
  const entries = (pack as unknown as PackThunk).build(
    ctx,
  ) as unknown as readonly Entry[];

  // One group per declaration; two declarations under one key are a pack bug.
  const groups = new Map<string, { decl: object; entries: Entry[] }>();
  for (const e of entries) {
    const g = groups.get(e.decl.key);
    if (g === undefined) {
      groups.set(e.decl.key, { decl: e.decl, entries: [e] });
    } else if (g.decl !== e.decl) {
      throw new DemoPackError(
        e.decl.key,
        "(declaration)",
        "two different declarations share this key.",
      );
    } else {
      g.entries.push(e);
    }
  }

  const serves = [...groups.values()].map((g) => {
    const first = g.entries[0]!;
    return first.kind === "value"
      ? valueServe(first.decl, g.entries)
      : collectionServe(first.decl, g.entries);
  });
  return (s) => {
    const erased = s as unknown as ErasedServe;
    return serves.map((serve) => serve(erased));
  };
}

function valueServe(
  decl: AnyValue,
  entries: readonly Entry[],
): (s: ErasedServe) => BrowserServed {
  const answers = new Map<string, unknown>();
  for (const e of entries) {
    if (e.kind !== "value") {
      throw new DemoPackError(
        decl.key,
        "(declaration)",
        "a value recorded as a collection.",
      );
    }
    if (answers.has(e.tuple)) {
      throw new DemoPackError(decl.key, e.tuple, "recorded twice.");
    }
    answers.set(e.tuple, e.data);
  }
  const answer = (tuple: string, params: unknown): unknown => {
    if (!answers.has(tuple)) throw new DemoMissingError(decl.key, params);
    return answers.get(tuple);
  };
  return (s) =>
    s.serveValue(decl, {
      source: "external",
      // A snapshot value pairs only with `changes: { snapshot }` (tsc there).
      changes:
        decl.snapshot === true
          ? { snapshot: { reason: "demo pack" } }
          : CHANGES,
      loader:
        decl.query !== undefined
          ? (q: unknown) => answer(valueTupleOfQuestion(canonicalJson(q)), q)
          : (params: Record<string, string>) =>
              answer(valueTupleOfParams(decl, params), params),
    });
}

function collectionServe(
  decl: AnyCollection,
  entries: readonly Entry[],
): (s: ErasedServe) => BrowserServed {
  const form =
    decl.all !== undefined
      ? "all"
      : decl.window !== undefined
        ? "window"
        : "lookup";

  // `:rows` answers from every row any entry lists.
  const pool = new Map<string, { row: Row; json: string }>();
  let all: Row[] | null = null;
  const windows = new Map<string, Row[]>();
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "value") {
      throw new DemoPackError(
        decl.key,
        "(declaration)",
        "a collection recorded as a value.",
      );
    }
    const tuple = e.kind === "window" ? e.tuple : `(${e.kind})`;
    for (const row of e.rows) {
      const id = row[decl.id] as string;
      const json = JSON.stringify(row);
      const seen = pool.get(id);
      if (seen !== undefined && seen.json !== json) {
        throw new DemoPackError(
          decl.key,
          tuple,
          `row "${id}" is recorded twice with different fields.`,
        );
      }
      pool.set(id, { row, json });
    }
    if (e.kind === "all") {
      if (form !== "all") {
        throw new DemoPackError(
          decl.key,
          tuple,
          "`packAll` on a collection not declared `all`.",
        );
      }
      if (all !== null)
        throw new DemoPackError(decl.key, tuple, "recorded twice.");
      const order = orderOf(decl, tuple, decl.all!.all.orderBy);
      all = sortRows(e.rows, order.keyOf, order.dirs).map((r) => r.row);
    } else if (e.kind === "window") {
      if (windows.has(e.tuple)) {
        throw new DemoPackError(decl.key, e.tuple, "recorded twice.");
      }
      windows.set(e.tuple, e.rows);
      if (e.count !== null) {
        const known = counts.get(e.count.tuple);
        if (known !== undefined && known !== e.count.n) {
          throw new DemoPackError(
            decl.key,
            e.tuple,
            `count ${e.count.n} disagrees with ${known}, recorded for the same \`where\`.`,
          );
        }
        counts.set(e.count.tuple, e.count.n);
      }
    }
  }

  const rows = (ids: readonly string[]): Row[] =>
    ids.flatMap((id) => {
      const hit = pool.get(id);
      return hit === undefined ? [] : [hit.row];
    });

  if (form === "lookup") {
    return (s) =>
      s.serveCollection(decl, { source: "external", changes: CHANGES, rows });
  }
  if (form === "all") {
    return (s) =>
      s.serveCollection(decl, {
        source: "external",
        changes: CHANGES,
        rows,
        all: () => {
          if (all === null) throw new DemoMissingError(decl.key, {});
          return all;
        },
      });
  }

  const keyText = Object.fromEntries(
    (decl.sortable ?? []).map((field) => [
      field,
      (value: unknown) => keyTextOf(decl, "(order)", field, value),
    ]),
  );
  const window = (q: LiveDecodedQuery<string>): Row[] => {
    const tuple = windowTuple(decl, { where: q.where, orderBy: q.orderBy });
    const recorded = windows.get(tuple);
    if (recorded === undefined) throw new DemoMissingError(decl.key, q);
    const { keyOf, dirs } = orderOf(decl, tuple, q.orderBy);
    return sortRows(recorded, keyOf, dirs)
      .filter(
        ({ key }) =>
          (q.after === undefined || compareParts(key, q.after, dirs) > 0) &&
          (q.until === undefined || compareParts(key, q.until, dirs) <= 0),
      )
      .slice(0, q.limit)
      .map((r) => r.row);
  };
  const counted = decl.count !== null && decl.count !== undefined;
  const count = (q: LiveDecodedCountQuery): number => {
    const n = counts.get(countTuple(decl, q.where));
    if (n === undefined) throw new DemoMissingError(`${decl.key}:count`, q);
    return n;
  };
  return (s) =>
    s.serveCollection(decl, {
      source: "external",
      changes: CHANGES,
      rows,
      window,
      keyText,
      ...(counted ? { count } : {}),
    });
}
