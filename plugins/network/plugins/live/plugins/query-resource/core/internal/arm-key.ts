// A union window's row key (research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md,
// step 11): a row of arm `kind` with raw id `raw` is keyed `kind:raw` — one
// key space over N tables whose own ids may collide. Browser-safe: the web
// half mints a row's key from a ref (`runRowKey`), the server's route plan
// encodes changed ids and decodes `within` through the same codec, and the
// SQL that projects the key (`armKeySql`, server) is tested byte-equal to it.

/**
 * What an arm kind (and a contributed column set's name) may be: a plain
 * identifier — no `:` (the key separator), no `.` (a wire name's and a route
 * id's separator). Also what keeps a kind safe to inline as a SQL literal.
 */
export const KIND_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** One arm's row-key codec. */
export interface ArmKeyCodec {
  readonly kind: string;
  /** `kind:raw` — the raw id as is (it may itself contain `:`). */
  encode(raw: string): string;
  /**
   * The raw id of a key of THIS arm (the prefix stripped once), or `null`
   * for a key of another arm — a legitimate answer, not a failure: a union's
   * key set mixes every arm's keys.
   */
  decode(key: string): string | null;
}

/** The row-key codec of arm `kind` (throws on a kind `KIND_RE` refuses). */
export function armKeyCodec(kind: string): ArmKeyCodec {
  if (!KIND_RE.test(kind)) {
    throw new Error(
      `armKeyCodec("${kind}"): an arm kind is a plain identifier (${String(KIND_RE)}) — it prefixes every row key and route id`,
    );
  }
  const prefix = `${kind}:`;
  return {
    kind,
    encode: (raw) => prefix + raw,
    decode: (key) => (key.startsWith(prefix) ? key.slice(prefix.length) : null),
  };
}
