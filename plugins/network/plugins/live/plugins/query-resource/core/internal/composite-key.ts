// A row key made of several fields — the one codec every key site of a
// collection over a composite primary key derives from (research/
// 2026-11-02-global-live-composite-key-collections.md, Decision 1): the
// client's and the runtime's `keyOf` (the descriptor's `keyed.keyOf`), the
// server's `orderOf` ids, the `:rows` point ids, the router's host ids (built
// from the change feed's carried key columns) and the refill's decode. One
// object, so no two of them can spell one row two ways.
//
// An id is each part `encodeURIComponent`-escaped, joined with `/`. The escape
// leaves no `/` and no `,` inside a part, so an id splits back unambiguously
// and is always a point id (`isPointId`: non-empty, comma-free — a point set
// joins its ids on `,`).
//
// A part is the field's value as TEXT: a string as is, an integer as its
// decimal text — exactly Postgres's own `col::text` of a text, uuid or integer
// column (the only types a key part may be: the server's compile checks each
// against its column), so an id built from a decoded row and one built from
// the change feed's carried keys are one string.

/** The most fields a composite key may name. */
export const COMPOSITE_KEY_MAX_FIELDS = 8;

/** A composite row key over the row fields `F`, in order. */
export interface CompositeKey<F extends string = string> {
  readonly kind: "composite-key";
  /** The key's fields, in order — at least two, each once. */
  readonly fields: readonly F[];
  /** A row's id: its key fields' text, escaped and joined. Throws on a part that is no string or safe integer. */
  encode(row: Readonly<Record<F, unknown>>): string;
  /** The id of a row whose key fields' texts are `parts` (in field order). Throws on a wrong count. */
  encodeParts(parts: readonly string[]): string;
  /**
   * The parts of `id`, or `null` when `id` is no id this key minted (a wrong
   * part count, a bad escape, a non-canonical spelling). Strict: a decoded id
   * re-encodes to itself, so one row has one id.
   */
  decode(id: string): string[] | null;
}

/**
 * Declare a composite key over `fields` (2 to {@link COMPOSITE_KEY_MAX_FIELDS},
 * each once). Throws on a declaration outside that.
 */
export function compositeKey<const F extends string>(
  fields: readonly [F, F, ...F[]],
): CompositeKey<F> {
  const label = `compositeKey(${JSON.stringify(fields)})`;
  if (fields.length < 2) {
    throw new Error(
      `${label}: a composite key names at least two fields — one field is the id itself.`,
    );
  }
  if (fields.length > COMPOSITE_KEY_MAX_FIELDS) {
    throw new Error(`${label}: at most ${COMPOSITE_KEY_MAX_FIELDS} fields.`);
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error(`${label}: a field is named twice.`);
  }
  const frozen = Object.freeze([...fields]);
  const encodeParts = (parts: readonly string[]): string => {
    if (parts.length !== frozen.length) {
      throw new Error(
        `${label}.encodeParts: ${parts.length} parts for ${frozen.length} fields.`,
      );
    }
    return parts.map((p) => encodeURIComponent(p)).join("/");
  };
  return Object.freeze({
    kind: "composite-key" as const,
    fields: frozen,
    encode: (row: Readonly<Record<F, unknown>>): string =>
      encodeParts(
        frozen.map((f) => {
          const v = row[f];
          if (typeof v === "string") return v;
          if (typeof v === "number" && Number.isSafeInteger(v))
            return String(v);
          throw new Error(
            `${label}.encode: field "${f}" is ${JSON.stringify(v)} — a key part is a string or a safe integer.`,
          );
        }),
      ),
    encodeParts,
    decode: (id: string): string[] | null => {
      const raw = id.split("/");
      if (raw.length !== frozen.length) return null;
      const parts: string[] = [];
      for (const r of raw) {
        const part = decodeComponent(r);
        if (part === null) return null;
        parts.push(part);
      }
      // One row, one id: an id spelled other than the encoder would spell it
      // (`%41` for `A`, a lower-case escape) names no row.
      return encodeParts(parts) === id ? parts : null;
    },
  });
}

/** Whether `id` (a collection's declared id) is a composite key rather than one field. */
export function isCompositeKey(id: unknown): id is CompositeKey {
  return (
    typeof id === "object" &&
    id !== null &&
    (id as { kind?: unknown }).kind === "composite-key"
  );
}

// `decodeURIComponent`, answering `null` for a malformed escape (its only
// failure) instead of throwing.
function decodeComponent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
}
