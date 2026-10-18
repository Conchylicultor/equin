// A row read from a live collection (`useLive(collection)`, its id sets,
// `useLiveRow`) carries this phantom mark, so a list over it is told apart from
// a list over rows of nothing declared: a DataView handed rows that came from a
// collection derives its fields from that collection (`collection=`), and its
// hand-`fields` arm refuses them (`NotCollectionRow`) — the fields a collection
// declares are never restated by a list.
//
// The key is optional and never set at runtime: a `CollectionRow<Row>` is
// assignable wherever a `Row` is, and a spread (`{ ...row, extra }`) keeps it —
// a row computed from a collection row is still one. A value nested inside a
// row (a JSON column's items) carries no mark.
declare const collectionRow: unique symbol;

/** A row of a live collection — see the module comment. */
export type CollectionRow<Row> = Row & { readonly [collectionRow]?: true };

/** A row that did NOT come from a live collection: `CollectionRow`s are a tsc error here. */
export type NotCollectionRow<Row> = Row & {
  readonly [collectionRow]?: never;
};
