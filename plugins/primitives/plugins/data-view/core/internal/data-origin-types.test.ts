/**
 * Types only: a list whose rows come from a live collection derives its
 * fields from it — hand `fields` beside a live `source`, beside a declared
 * `collection`, or over rows read from a collection (`CollectionRow`) do not
 * compile. Each case is a function never called; tsc is the assertion.
 */
import { describe, expect, test } from "bun:test";
import type { CollectionRow } from "@plugins/network/plugins/live/core";
import type { LiveDataSource } from "./live-data-source";
import type {
  DataViewDataOrigin,
  DataViewRowsCollection,
  FieldDef,
} from "./types";

interface Note {
  id: string;
  title: string;
}

const origin = <TRow>(o: DataViewDataOrigin<TRow>): DataViewDataOrigin<TRow> =>
  o;
declare const fields: FieldDef<Note>[];
declare const notes: readonly Note[];
declare const collectionNotes: readonly CollectionRow<Note>[];
declare const collection: DataViewRowsCollection;
declare const source: LiveDataSource<Note>;
const rowKey = (row: { id: string }): string => row.id;
const spread = () => collectionNotes.map((n) => ({ ...n, extra: 1 }));

describe("data origin types", () => {
  test("hand fields only over rows of nothing declared", () => {
    const cases = [
      () => origin({ rows: notes, rowKey, fields }),
      () => origin({ rows: collectionNotes, rowKey, collection }),
      () => origin({ source }),
      // @ts-expect-error — rows read from a collection: pass `collection`
      () => origin({ rows: collectionNotes, rowKey, fields }),
      // @ts-expect-error — a row spread from a collection row is still one
      () => origin({ rows: spread(), rowKey, fields: [] }),
      // @ts-expect-error — `fields` beside a declared collection
      () => origin({ rows: notes, rowKey, collection, fields }),
      // @ts-expect-error — `fields` beside a live source
      () => origin({ source, fields }),
    ];
    expect(cases.length).toBe(7);
  });
});
