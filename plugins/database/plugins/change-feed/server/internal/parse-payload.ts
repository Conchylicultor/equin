// Pure parser for a `live_state` NOTIFY payload. Kept separate from the listener
// so it can be unit-tested without a DB socket.
//
// The payload is the JSON emitted by `live_state_notify()`:
//   { "t": "<table>", "op": "I" | "U" | "D", "ids": string[] | null, "x": "<xid8>", "at": <epoch ms> }
// or, for a ROUTED table (one a compiled route reads), by
// `live_state_notify_routed()`, which adds
//   "k": { "c": string[], "r": (string | null)[][] } | null  — the key layout, one array per row
//   "u": string[] | null                                  — an UPDATE's known-unchanged gate columns
// `op` is the first letter of TG_OP. `ids` is an array of PK values as strings,
// or null (composite/no PK, or an over-cap statement → FULL-for-table). `x` is
// the source transaction id (`pg_current_xact_id()::text` — the same xid8 the
// changelog row stores), threaded through the recompute cascade as the
// mutation-ack attribution (`ackTx`). Parsed TOLERANTLY: absent or malformed
// `x` (a pre-upgrade NOTIFY) yields `xid: null` — a missing ack is safe, a
// dropped change is not.
//
// Parsing is intentionally strict on shape but never throws: a payload whose
// table / op / ids cannot be read returns null so the listener can log + skip
// rather than crash. The change-feed must never be taken down by one bad message.
// A routed layout (`k` / `u`) that does not parse is NOT a reason to skip: the
// table and op are known, so the change degrades to unscoped (`readLayout`) —
// exactly what the catch-up replay does with the same row.

export type DbChange = {
  table: string;
  op: "I" | "U" | "D";
  ids: string[] | null;
  xid: string | null;
  /**
   * Wall-clock epoch ms of the statement (`clock_timestamp()` in the trigger), or
   * null. Observability only: it lets an open tab measure change → applied.
   * Null for a pre-upgrade NOTIFY and for every catch-up replay row.
   */
  changedAt: number | null;
  /**
   * A routed table's key layout, COLUMNAR (column → one value per row, row
   * aligned, DISTINCT over the rows touched — `old ∪ new` for an UPDATE); null
   * when the table carries none, the statement was over the NOTIFY cap, or the
   * NOTIFY came from the PK-only trigger.
   */
  keys: Record<string, (string | null)[]> | null;
  /**
   * An UPDATE on a gated routed table: the gate columns whose value is equal
   * in every row (see `TableChange.unchanged`). null = nothing known — not
   * gated, a PK moved, or not an UPDATE; `[]` = every compared column moved.
   */
  unchanged: string[] | null;
};

/**
 * The trigger's row-wise `{ c, r }` key layout as the router's columnar one,
 * or `undefined` when it is malformed (see `readLayout`, which degrades the
 * change to unscoped).
 */
export function parseKeyLayout(
  raw: unknown,
): Record<string, (string | null)[]> | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { c: columns, r: rows } = raw as { c?: unknown; r?: unknown };
  if (
    !Array.isArray(columns) ||
    columns.length === 0 ||
    !columns.every((x) => typeof x === "string") ||
    new Set(columns).size !== columns.length
  ) {
    return undefined;
  }
  // `json_agg` over zero rows is NULL; the trigger returns before it on a
  // statement that touched nothing, but an empty layout is still a layout.
  const list = rows === null ? [] : rows;
  if (!Array.isArray(list)) return undefined;
  const out: Record<string, (string | null)[]> = Object.fromEntries(
    (columns as string[]).map((c) => [c, []]),
  );
  for (const row of list) {
    if (
      !Array.isArray(row) ||
      row.length !== columns.length ||
      !row.every((v) => v === null || typeof v === "string")
    ) {
      return undefined;
    }
    (columns as string[]).forEach((c, i) =>
      out[c]!.push(row[i] as string | null),
    );
  }
  return out;
}

/** An UPDATE's unchanged-column list, or `undefined` when malformed. */
export function parseUnchangedColumns(
  raw: unknown,
): string[] | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) {
    return undefined;
  }
  return raw as string[];
}

/** The scope of one change: its ids, key layout and unchanged columns. */
export type ChangeScope = Pick<DbChange, "ids" | "keys" | "unchanged">;

/**
 * A change's scope from its raw layout — the ONE rule the live NOTIFY and the
 * catch-up replay both apply, so a row routes the same whichever path reads
 * it. A layout (`keys`) or unchanged set that does not parse cannot say which
 * rows or columns moved, so the change is UNSCOPED — `ids`, `keys` and
 * `unchanged` all null, FULL for its readers — and `malformed` says so for the
 * caller to report. Never dropped: the table and op are known, and a dropped
 * change is stale data.
 */
export function readLayout(
  ids: string[] | null,
  rawKeys: unknown,
  rawUnchanged: unknown,
): { scope: ChangeScope; malformed: boolean } {
  const keys = parseKeyLayout(rawKeys);
  const unchanged = parseUnchangedColumns(rawUnchanged);
  if (keys === undefined || unchanged === undefined) {
    return {
      scope: { ids: null, keys: null, unchanged: null },
      malformed: true,
    };
  }
  return { scope: { ids, keys, unchanged }, malformed: false };
}

export function parseLiveStatePayload(
  raw: string,
  /** Told when the change degraded to unscoped because its layout was malformed. */
  onMalformedLayout?: (change: DbChange) => void,
): DbChange | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A malformed payload is the expected bad case → skip. Anything that isn't a
    // JSON syntax error is unexpected and must fail loudly.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const table = obj.t;
  const op = obj.op;
  const ids = obj.ids;

  if (typeof table !== "string" || table.length === 0) return null;
  if (op !== "I" && op !== "U" && op !== "D") return null;

  let normalizedIds: string[] | null;
  if (ids === null || ids === undefined) {
    normalizedIds = null;
  } else if (Array.isArray(ids) && ids.every((x) => typeof x === "string")) {
    normalizedIds = ids as string[];
  } else {
    // Present but wrong shape — bad payload, skip the whole change.
    return null;
  }

  // Tolerant: a pre-upgrade NOTIFY has no `x`; a malformed one degrades to null
  // (missing ack attribution is safe) rather than rejecting the change.
  const x = obj.x;
  const xid = typeof x === "string" && x.length > 0 ? x : null;

  // Tolerant like `x`: a missing or malformed `at` loses one latency sample,
  // never the change.
  const at = obj.at;
  const changedAt = typeof at === "number" && Number.isFinite(at) ? at : null;

  // A routed trigger's layout that does not parse would route wrong rows: the
  // change goes unscoped (never skipped — see `readLayout`).
  const { scope, malformed } = readLayout(normalizedIds, obj.k, obj.u);
  const change: DbChange = { table, op, xid, changedAt, ...scope };
  if (malformed) onMalformedLayout?.(change);
  return change;
}

/**
 * A transaction's end marker: the `live_state_end` NOTIFY that
 * `live_state_txn_end()` sends once per transaction, at commit, after every
 * one of its `live_state` NOTIFYs. `n` is how many changelog rows (statements)
 * the transaction wrote — an upper bound on its `live_state` NOTIFYs, since
 * Postgres delivers one of several identical payloads.
 */
export interface TxnEnd {
  xid: string;
  n: number;
}

/**
 * Parse a `live_state_end` payload (`{"x": "<xid8>", "n": <count>}`), STRICTLY:
 * the router holds a transaction's changes until its end, so an end it cannot
 * read must not be taken for some other one. `null` when the payload is not
 * exactly that shape — the listener reports it and the transaction's changes
 * are released by their deadline, never dropped.
 */
export function parseTxnEndPayload(raw: string): TxnEnd | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const { x, n, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (typeof x !== "string" || !/^[0-9]+$/.test(x)) return null;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return null;
  return { xid: x, n };
}
