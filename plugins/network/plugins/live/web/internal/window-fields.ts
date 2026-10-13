import {
  LIVE_ROW_KEY,
  LIVE_SCOPED_KEY,
} from "@plugins/network/plugins/live/core";

// A window row may carry two server-minted fields beside its row fields: its
// `$key` (so a page can be cut at the row) and a scoped
// collection's `$scoped` (the scoped column values its tuple orders by, which
// the order signature reads). Neither is a row field: every read hands rows out
// without them.

/** A row with its window-only fields (`$key`, `$scoped`) split off — one copy per server row object, so identity holds across pushes. */
const stripped = new WeakMap<object, object>();

export function withoutWindowFields<Row>(row: Row): Row {
  const o = row as unknown as Record<string, unknown>;
  let s = stripped.get(o);
  if (s === undefined) {
    const { [LIVE_ROW_KEY]: _key, [LIVE_SCOPED_KEY]: _scoped, ...rest } = o;
    s = rest;
    stripped.set(o, s);
  }
  return s as Row;
}
