import {
  isRowUnknown,
  type RowFieldState,
} from "@plugins/network/plugins/live/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { FieldDef, FieldValue } from "../../core";
import type { ExtensionField } from "./field-extension-types";

// The two folds every field whose values come from a read of its own goes
// through — a client-field resolver's readers (`ClientValuesLevel`) and a field
// extension's (`FieldExtensionStep`) — so "not known yet" is decided by the
// host from the read, never by a contributor writing a stand-in value.

/** What a field's whole-surface read says, folded once for every field it feeds. */
export type FieldReadFold<T> =
  /** Known (or failed over a held answer, which keeps painting it). */
  | { kind: "known"; data: T }
  /** Loading with nothing held: the field is `pending`. */
  | { kind: "pending" }
  /** Failed with nothing held: the field's `readError`. */
  | {
      kind: "failed";
      readError: { error: Error; refetch?: () => Promise<void> };
    };

export function foldFieldRead<T>(read: ResourceResult<T>): FieldReadFold<T> {
  if (read.status === "ready") return { kind: "known", data: read.data };
  if (read.status === "loading") return { kind: "pending" };
  if (read.stale !== undefined) return { kind: "known", data: read.stale };
  return {
    kind: "failed",
    readError: { error: read.error, refetch: read.refetch },
  };
}

/**
 * A field extension's fields with their read stamped on: each field's `value`
 * from its reader, `pending` / `readError` from the read's state. One reader
 * per field — a reader for an id no field declares, or a field with none,
 * throws (inside the contributor's own boundary, where it is named).
 */
export function stampExtensionRead<TRow>(
  fields: readonly ExtensionField<TRow>[],
  values: ResourceResult<Readonly<Record<string, (row: TRow) => FieldValue>>>,
): FieldDef<TRow>[] {
  const read = foldFieldRead(values);
  if (read.kind === "known") {
    const declared = new Set(fields.map((f) => f.id));
    const stray = Object.keys(read.data).filter((id) => !declared.has(id));
    if (stray.length > 0) {
      throw new Error(
        `data-view: a field extension read values for ${stray.map((id) => `"${id}"`).join(", ")}, which it declares no field for`,
      );
    }
  }
  return fields.map((f): FieldDef<TRow> => {
    if (read.kind === "pending") {
      return { ...f, value: UNKNOWN, pending: true } as FieldDef<TRow>;
    }
    if (read.kind === "failed") {
      return {
        ...f,
        value: UNKNOWN,
        readError: read.readError,
      } as FieldDef<TRow>;
    }
    const reader = read.data[f.id];
    if (reader === undefined) {
      throw new Error(
        `data-view: the field extension's field "${f.id}" has no reader in its values`,
      );
    }
    return { ...f, value: reader } as FieldDef<TRow>;
  });
}

// What a pending or failed field's `value` answers — never read for a cell
// (`FieldCell` draws the loading block / the failure first), and a view laid
// out by the field renders its loading / failure instead of its rows.
const UNKNOWN = (): FieldValue => undefined;

const KNOWN: RowFieldState = { status: "known" };

/**
 * Split a per-row reader's answer once: `value` is the known value
 * (`undefined` for a row not known yet / failed — never read for one, since
 * `rowState` keeps it out of every layout), `rowState` what is known. Both are
 * read off ONE call per row object (memoised), so they cannot disagree.
 */
export function splitRowReader(read: (row: unknown) => unknown): {
  value: (row: unknown) => FieldValue;
  rowState: (row: unknown) => RowFieldState;
} {
  const memo = new WeakMap<object, unknown>();
  const answer = (row: unknown): unknown => {
    if (typeof row !== "object" || row === null) return read(row);
    if (memo.has(row)) return memo.get(row);
    const a = read(row);
    memo.set(row, a);
    return a;
  };
  return {
    value: (row) => {
      const a = answer(row);
      return (isRowUnknown(a) ? undefined : a) as FieldValue;
    },
    rowState: (row) => {
      const a = answer(row);
      return isRowUnknown(a) ? a.state : KNOWN;
    },
  };
}

/** The rows a view lays out, and those it cannot place yet (see {@link partitionKnownRows}). */
export interface KnownRowsPartition {
  readonly laidOut: readonly unknown[];
  /** Each row not known for some laid-out-by field, with that field's state (the first one not known). */
  readonly notKnown: readonly NotKnownRow[];
}

export interface NotKnownRow {
  readonly row: unknown;
  readonly field: { readonly id: string; readonly label: string };
  readonly state: Exclude<RowFieldState, { status: "known" }>;
}

/**
 * Split `rows` by whether each is known for every one of `readFields` (the
 * fields the view groups, sorts, filters or folds by) that reads its rows one
 * by one (`rowState`). The rest have no bucket, position or match yet: the
 * view lays out only the known ones and draws the others in its pending tail.
 * Same array back when nothing is withheld.
 */
export function partitionKnownRows(
  rows: readonly unknown[],
  readFields: readonly {
    id: string;
    label: string;
    rowState?: (row: never) => RowFieldState;
  }[],
): KnownRowsPartition {
  const perRow = readFields.filter((f) => f.rowState !== undefined);
  if (perRow.length === 0) return { laidOut: rows, notKnown: NO_NOT_KNOWN };
  const laidOut: unknown[] = [];
  const notKnown: NotKnownRow[] = [];
  for (const row of rows) {
    let pending: NotKnownRow | null = null;
    for (const f of perRow) {
      const state = f.rowState!(row as never);
      if (state.status !== "known") {
        pending = { row, field: { id: f.id, label: f.label }, state };
        break;
      }
    }
    if (pending === null) laidOut.push(row);
    else notKnown.push(pending);
  }
  return notKnown.length === 0
    ? { laidOut: rows, notKnown: NO_NOT_KNOWN }
    : { laidOut, notKnown };
}

const NO_NOT_KNOWN: readonly NotKnownRow[] = [];
