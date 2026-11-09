import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useLive,
  type LiveValueListOptions,
  type LiveValueTupleRead,
} from "@plugins/network/plugins/live/web";
import type {
  LiveCollection,
  LivePlainValue,
  LiveValueOrigin,
} from "@plugins/network/plugins/live/core";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type {
  FieldCollectionRowRead,
  FieldDef,
  FieldRowRead,
  FieldValueRowRead,
} from "../../core";

// A field's per-row live read (`FieldDef.rowRead`), read by the DataView for
// the rows on screen — never by each row's cell. A `useLive` per row is one
// subscription per row MOUNTED (a windowed list mounts every row a scroll
// passes, and a released tuple lingers for the keep-alive), so a list's
// subscriptions grow with its length and with how far it was scrolled — the
// file explorer's Size column sent 314 `host-fs.peek` subs for one scroll
// through /tmp. Here one list read per field holds exactly the on-screen rows'
// tuples: a row entering the screen adds its tuple, one leaving releases it at
// once (`release: "now"`).

// biome-ignore lint/suspicious/noExplicitAny: a declaration's value type is invariant — erased, as `FieldRowRead` erases it.
type AnyPlainValue = LivePlainValue<any, any, LiveValueOrigin>;

type ParamsOf<V> =
  V extends LivePlainValue<unknown, infer P, LiveValueOrigin> ? P : never;

/**
 * A field's per-row live read — `FieldDef.rowRead` — typed by the value it
 * reads: `params` is the row's tuple of `value` (`null`: the row reads
 * nothing), and `cell` is handed the row's read exactly as
 * `useLive(value, [params])` would type it (its refusal codes, the
 * unavailable arm of a value that needs the computer).
 *
 * ```tsx
 * { id: "size", label: "Size",
 *   rowRead: rowRead({
 *     value: computerDirPeek,
 *     params: (r: EntryRow) => (r.kind === "dir" ? { path: r.path } : null),
 *     cell: (r, peek) => <FolderSize row={r} peek={peek} />,
 *   }) }
 * ```
 */
export function rowRead<Row, V extends AnyPlainValue>(spec: {
  value: V;
  params: (row: Row) => ParamsOf<V> | null;
  cell: (row: Row, read: LiveValueTupleRead<V>) => ReactNode;
}): FieldRowRead<Row>;
/**
 * …or ONE ROW of a collection per row — `id` names it (`null`: the row reads
 * none), and `cell` is handed it as a `ResourceResult` whose data is the row,
 * or `null` when the collection holds no such row — `undefined` while the row
 * is off screen or reads none (no read made for it). The DataView reads every
 * on-screen row's id in one `useLive(collection, { ids })`.
 *
 * ```tsx
 * { id: "parent", label: "Parent",
 *   rowRead: rowRead({
 *     collection: tasks,
 *     id: (t: Task) => t.folderId,
 *     cell: (t, parent) => <ParentLabel parent={parent} />,
 *   }) }
 * ```
 */
export function rowRead<Row, Target, F, S extends string>(spec: {
  collection: LiveCollection<Target, F, S>;
  id: (row: Row) => string | null;
  cell: (
    row: Row,
    read: ResourceResult<Target | null> | undefined,
  ) => ReactNode;
}): FieldRowRead<Row>;
export function rowRead(
  spec:
    | { value: unknown; params: unknown; cell: unknown }
    | { collection: unknown; id: unknown; cell: unknown },
): FieldRowRead<unknown> {
  return "collection" in spec
    ? ({ kind: "row", ...spec } as unknown as FieldCollectionRowRead<unknown>)
    : ({ kind: "value", ...spec } as unknown as FieldValueRowRead<unknown>);
}

/**
 * Field id → that field's reads: each on-screen row's by its key, and the
 * read a row not read is handed (off screen, or `params` `null`).
 */
type RowReads = ReadonlyMap<
  string,
  { byRow: ReadonlyMap<string, unknown>; notRead: unknown }
>;

interface RowReadsValue {
  reads: RowReads;
  rowKey: (row: unknown) => string;
}

const RowReadsContext = createContext<RowReadsValue | null>(null);

/**
 * The fields with the cell of every `rowRead` field drawn from the body's
 * reads ({@link RowReadsHost}) — so every view, whichever way it draws a
 * cell (`FieldCell`, or `field.cell` called directly), draws it the same.
 * Throws on a field declaring `rowRead` beside its own `cell` / `token`.
 */
export function withRowReadCells<TRow>(
  fields: readonly FieldDef<TRow>[],
): FieldDef<TRow>[] {
  if (!fields.some((f) => f.rowRead !== undefined)) return [...fields];
  return fields.map((f) => {
    const read = f.rowRead;
    if (read === undefined) return f;
    if (f.cell !== undefined || f.token !== undefined) {
      throw new Error(
        `data-view: field "${f.id}" declares \`rowRead\` beside its own \`cell\` / \`token\` — a row read's cell is its \`rowRead.cell\``,
      );
    }
    const cell = (row: TRow) => (
      <RowReadCell field={f.id} read={read} row={row} />
    );
    return { ...f, cell, token: cell };
  });
}

function RowReadCell<TRow>(props: {
  field: string;
  read: FieldRowRead<TRow>;
  row: TRow;
}): ReactNode {
  const { field, read, row } = props;
  const ctx = useContext(RowReadsContext);
  if (ctx === null) {
    throw new Error(
      `data-view: field "${field}"'s row read is drawn outside its DataView — only the DataView that holds the row reads it`,
    );
  }
  const reads = ctx.reads.get(field);
  if (reads === undefined) {
    throw new Error(
      `data-view: field "${field}" declares \`rowRead\` but its DataView read none — the host mounts one read per such field`,
    );
  }
  const key = ctx.rowKey(row);
  return read.cell(
    row,
    reads.byRow.has(key) ? reads.byRow.get(key) : reads.notRead,
  );
}

/**
 * Read every `rowRead` field for the rows on screen, and provide the reads
 * to their cells. `onScreen` is the set of row keys the view has on screen
 * (`null`: not measured yet — nothing is read); `rows` are the view's rows,
 * keyed by `rowKey`.
 */
export function RowReadsHost(props: {
  fields: readonly FieldDef<unknown>[];
  rows: readonly unknown[];
  rowKey: (row: unknown, index: number) => string;
  onScreen: ReadonlySet<string> | null;
  children: ReactNode;
}): ReactNode {
  const { fields, rows, rowKey, onScreen, children } = props;
  const reading = useMemo(
    () => fields.filter((f) => f.rowRead !== undefined),
    [fields],
  );
  const byKey = useMemo(() => {
    if (reading.length === 0) return null;
    const m = new Map<string, unknown>();
    rows.forEach((row, i) => m.set(rowKey(row, i), row));
    return m;
  }, [reading, rows, rowKey]);
  // The on-screen rows, with their keys — the list each field's read is made
  // over (in the measurement's order: a tuple is kept by identity, so a
  // reordering re-subscribes nothing).
  const visible = useMemo(() => {
    if (byKey === null || onScreen === null) return NO_VISIBLE;
    const out: { key: string; row: unknown }[] = [];
    for (const key of onScreen) {
      if (byKey.has(key)) out.push({ key, row: byKey.get(key) });
    }
    return out;
  }, [byKey, onScreen]);
  const keyOf = useMemo(() => (row: unknown) => rowKey(row, 0), [rowKey]);
  if (reading.length === 0) return children;
  return (
    <ReadFields
      fields={reading}
      visible={visible}
      reads={NO_READS}
      rowKey={keyOf}
    >
      {children}
    </ReadFields>
  );
}

const NO_VISIBLE: readonly { key: string; row: unknown }[] = [];
const NO_READS: RowReads = new Map();
const RELEASE_NOW: LiveValueListOptions = { release: "now" };

/** One level per `rowRead` field (a hook call each), then the provider. */
function ReadFields(props: {
  fields: readonly FieldDef<unknown>[];
  visible: readonly { key: string; row: unknown }[];
  reads: RowReads;
  rowKey: (row: unknown) => string;
  children: ReactNode;
}): ReactNode {
  const { fields, visible, reads, rowKey, children } = props;
  const value = useMemo(() => ({ reads, rowKey }), [reads, rowKey]);
  if (fields.length === 0) {
    return (
      <RowReadsContext.Provider value={value}>
        {children}
      </RowReadsContext.Provider>
    );
  }
  const [first, ...rest] = fields;
  return (
    <ReadField field={first!} visible={visible} reads={reads}>
      {(withField) => (
        <ReadFields
          fields={rest}
          visible={visible}
          reads={withField}
          rowKey={rowKey}
        >
          {children}
        </ReadFields>
      )}
    </ReadField>
  );
}

/** Erased: the declaration's value and tuples are typed by `rowRead()`. */
type ErasedListRead = (
  value: AnyPlainValue,
  list: readonly (Record<string, string> | null)[],
  options: LiveValueListOptions,
) => readonly unknown[] | { status: "unavailable" };

/** One field's read, by the kind of read it declares. */
function ReadField(props: {
  field: FieldDef<unknown>;
  visible: readonly { key: string; row: unknown }[];
  reads: RowReads;
  children: (reads: RowReads) => ReactNode;
}): ReactNode {
  const spec = props.field.rowRead!;
  return spec.kind === "value" ? (
    <ReadValueField {...props} spec={spec} />
  ) : (
    <ReadRowField {...props} spec={spec} />
  );
}

/**
 * A value field's read: ONE `useLive` list read over the on-screen rows'
 * tuples (a row reading nothing is left out), released at once as rows leave —
 * handed on added to `reads`, the fields read before it.
 */
function ReadValueField(props: {
  field: FieldDef<unknown>;
  spec: FieldValueRowRead<unknown>;
  visible: readonly { key: string; row: unknown }[];
  reads: RowReads;
  children: (reads: RowReads) => ReactNode;
}): ReactNode {
  const { field, spec, visible, reads: before, children } = props;
  const tuples = useMemo(() => {
    const keys: string[] = [];
    const params: Record<string, string>[] = [];
    for (const { key, row } of visible) {
      const p = spec.params(row);
      if (p === null) continue;
      keys.push(key);
      params.push(p);
    }
    return { keys, params };
  }, [spec, visible]);
  // One trailing `null` entry — a skip, which reads nothing and answers
  // `loading` — is the read a row not read is handed.
  const list = useMemo(() => [...tuples.params, null], [tuples]);
  const results = (useLive as unknown as ErasedListRead)(
    spec.value,
    list,
    RELEASE_NOW,
  );
  const reads = useMemo(() => {
    // A value that needs the computer, under a transport without it: the
    // whole list is that one answer — every row's.
    const at = (i: number) => (Array.isArray(results) ? results[i] : results);
    const byRow = new Map<string, unknown>();
    tuples.keys.forEach((k, i) => byRow.set(k, at(i)));
    return new Map([
      ...before,
      [field.id, { byRow, notRead: at(tuples.keys.length) }],
    ]);
  }, [tuples, results, before, field.id]);
  return children(reads);
}

/**
 * A row field's read: the ids the on-screen rows name, ONE `{ ids }` read of
 * the collection (the set follows the screen: a row leaving drops its id) —
 * each row handed the row its id names (`null`: not in the collection).
 */
function ReadRowField(props: {
  field: FieldDef<unknown>;
  spec: FieldCollectionRowRead<unknown>;
  visible: readonly { key: string; row: unknown }[];
  reads: RowReads;
  children: (reads: RowReads) => ReactNode;
}): ReactNode {
  const { field, spec, visible, reads: before, children } = props;
  const wanted = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const { key, row } of visible) {
      const id = spec.id(row);
      if (id !== null) byKey.set(key, id);
    }
    return { byKey, ids: [...new Set(byKey.values())].sort() };
  }, [spec, visible]);
  const idKey = wanted.ids.join("\n");
  // No row on screen names one: nothing to read.
  if (idKey === "") {
    return (
      <WithReads before={before} field={field.id} byRow={NO_ROW_READS}>
        {children}
      </WithReads>
    );
  }
  return (
    <IdsRead key={idKey} collection={spec.collection} wanted={wanted}>
      {(byRow) => (
        <WithReads before={before} field={field.id} byRow={byRow}>
          {children}
        </WithReads>
      )}
    </IdsRead>
  );
}

type Keyed = { readonly [k: string]: unknown };

/**
 * ONE `{ ids }` read of `collection` (keyed by the set, so its query never
 * changes under it), each wanting row handed the row its id names.
 */
function IdsRead(props: {
  collection: LiveCollection<unknown, unknown, string>;
  wanted: { byKey: ReadonlyMap<string, string>; ids: readonly string[] };
  children: (byRow: ReadonlyMap<string, unknown>) => ReactNode;
}): ReactNode {
  const { collection, wanted, children } = props;
  const read = useLive(
    collection as LiveCollection<Keyed, Record<string, never>, string>,
    { ids: wanted.ids },
  ) as ResourceResult<readonly Keyed[]>;
  const idField = collection.id as string;
  const byRow = useMemo(() => {
    const out = new Map<string, unknown>();
    for (const [key, id] of wanted.byKey) {
      out.set(
        key,
        mapResource(
          read,
          (rows) => rows.find((r) => String(r[idField]) === id) ?? null,
        ),
      );
    }
    return out;
  }, [read, wanted, idField]);
  return children(byRow);
}

/** The reads so far, with this field's added. */
function WithReads(props: {
  before: RowReads;
  field: string;
  byRow: ReadonlyMap<string, unknown>;
  children: (reads: RowReads) => ReactNode;
}): ReactNode {
  const { before, field, byRow, children } = props;
  const reads = useMemo(
    () => new Map([...before, [field, { byRow, notRead: NOT_READ }]]),
    [before, field, byRow],
  );
  return children(reads);
}

const NO_ROW_READS: ReadonlyMap<string, unknown> = new Map();

/** What a row handed no read gets: none (off screen, or reading nothing). */
const NOT_READ = undefined;
