// A row key — what a key-range page is cut at. The server mints it on every
// row a paged read holds (`$key`); a page's tuple carries it back verbatim as a
// cut. Every check a cut must pass, whatever the source that minted it, is
// here: the codecs that take a cut add only what their source knows (the
// arity of its order).

/**
 * The reserved window-only row field a paged read's rows carry: the canonical
 * JSON array of the row's order-key values as exact text (a collection's
 * window: Postgres `col::text`), then its id — or `null` when that JSON
 * is over {@link LIVE_ROW_KEY_MAX_BYTES} (a long text sort key), at which no
 * page can be cut. It is not a row field: every read splits it off before
 * rows reach a consumer.
 */
export const LIVE_ROW_KEY = "$key";

/** A `$key` over this many bytes is projected as `null` — cuts ride in every tuple's params. */
export const LIVE_ROW_KEY_MAX_BYTES = 1024;

/** A decoded cut: each order key's exact text (NULL a NULL key), then the id. */
export type LiveCutKey = readonly (string | null)[];

/**
 * Parse one cut — `which` names it in a failure — as a row key of exactly
 * `arity` parts: canonical JSON, at most {@link LIVE_ROW_KEY_MAX_BYTES}
 * (no row key past it is minted), every part text or NULL, and the last —
 * the id — never NULL. Each failure goes to `onFail`, which throws (a codec
 * passes its own: a plain `Error` on encode, a contract mismatch on decode).
 */
export function parseRowKey(
  raw: string,
  arity: number,
  which: string,
  onFail: (message: string) => never,
): LiveCutKey {
  if (new TextEncoder().encode(raw).length > LIVE_ROW_KEY_MAX_BYTES) {
    onFail(
      `"${which}" is over ${LIVE_ROW_KEY_MAX_BYTES} bytes — no row key that long is minted`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return onFail(`decode: invalid JSON ${JSON.stringify(raw)}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== arity ||
    !parsed.every((v) => v === null || typeof v === "string") ||
    parsed[arity - 1] === null
  ) {
    onFail(
      `"${which}" must be a row key of ${arity} text values (the order's keys, then the id) — got ${JSON.stringify(raw)}`,
    );
  }
  if (JSON.stringify(parsed) !== raw) {
    onFail(`"${which}" is not canonical — got ${JSON.stringify(raw)}`);
  }
  return parsed as LiveCutKey;
}
