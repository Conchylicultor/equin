import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/**
 * An id of kind `P`: a plain string at runtime, branded at compile time so an
 * `Id<"task">` cannot be passed where an `Id<"conv">` is expected, and so the
 * only ways to hold one are the kind's own {@link IdKind.mint},
 * {@link IdKind.parse}, {@link IdKind.is} guard or {@link IdKind.schema}.
 *
 * Assignable TO `string` (every reader of a plain id keeps working); a plain
 * `string` is not assignable to it.
 */
export type Id<P extends string> = string & { readonly __idKind: P };

/** The id type a kind mints: `IdOf<typeof taskId>` = `Id<"task">`. */
export type IdOf<K> = K extends IdKind<infer P, IdShape> ? Id<P> : never;

/**
 * The closed set of body shapes a kind mints. Recognition is NOT per shape —
 * see {@link GENERIC_BODY} — so a kind changing its shape never stops
 * recognising its old rows.
 *
 * - `stamped` — `<prefix>-<epochSeconds>-<6 base36>`: short, creation-sortable,
 *   readable in prose. For entities a person or an agent names.
 * - `uuid` — `<prefix>-<uuid v4>`: collision-free per mint. For bulk or
 *   client-side mints (page blocks) and high-rate plumbing.
 * - `hash` — `<prefix>-<caller-supplied hex digest>`: content-addressed ids;
 *   `mint(digest)`.
 */
export type IdShape = "stamped" | "uuid" | "hash";

export const ID_SHAPES: readonly IdShape[] = ["stamped", "uuid", "hash"];

/** A prefix (or alias): lowercase, 2–10 chars, no hyphen — the hyphen is the separator. */
export const ID_PREFIX_RE = /^[a-z][a-z0-9]{1,9}$/;

const UUID_BODY =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Every stamped body the repo has ever minted: epoch seconds (10 digits) or
// milliseconds (13), and a 4–8 char base36 suffix (att/conv/proto minted 4,
// task and the current mint 6).
const STAMPED_BODY = "\\d{9,13}-[a-z0-9]{4,8}";
const HASH_BODY = "[0-9a-f]{32,64}";
// The suffix-less `claude-<epoch>` form, the oldest worktree/session names.
// Recognised under an ALIAS only: a current prefix never minted it, and in
// prose `task-1755000000` is far more likely a fragment than an id.
const LEGACY_EPOCH_BODY = "\\d{9,13}";

/**
 * The generic recognition body every kind shares, whatever it mints: a
 * stamped body or a uuid (plus a hex digest for `hash` kinds). So
 * `block-<epochMillis>-<6>`, `block-<uuid>`, `task-<ms>-<6>`, `att-<s>-<4>` and
 * the `<prefix>-<uuid>` a bare-uuid rewrite produces are all recognised with no
 * kind declaring a legacy regex of its own.
 */
function bodyFor(shape: IdShape): string {
  return shape === "hash"
    ? `(?:${UUID_BODY}|${STAMPED_BODY}|${HASH_BODY})`
    : `(?:${UUID_BODY}|${STAMPED_BODY})`;
}

/** Thrown by {@link IdKind.parse} for a string that is not an id of the kind. */
export class IdParseError extends Error {
  readonly prefix: string;
  readonly input: string;
  constructor(prefix: string, label: string, input: string) {
    super(
      `[ids] ${JSON.stringify(input)} is not a ${label} id (expected \`${prefix}-<id>\`)`,
    );
    this.name = "IdParseError";
    this.prefix = prefix;
    this.input = input;
  }
}

/** What `mint` takes: nothing, or the digest a `hash` kind names. */
type MintFn<P extends string, S extends IdShape> = S extends "hash"
  ? (digest: string) => Id<P>
  : () => Id<P>;

/** One declared id kind. Build it with {@link defineIdKind}. */
export interface IdKind<P extends string, S extends IdShape = IdShape> {
  readonly prefix: P;
  readonly label: string;
  readonly shape: S;
  /**
   * Recognition-only legacy prefixes (`claude` for att/conv). Never minted,
   * and never read by {@link pattern}: an alias is recognised only where the
   * caller already KNOWS the kind it is reading ({@link is}, {@link parse},
   * {@link schema}, {@link recognitionPattern} — a worktree name, a
   * route param). Inline detection infers the kind FROM the text,
   * and an alias two kinds share (`claude-…` named both an attempt and its
   * conversation) cannot say which one it is.
   */
  readonly aliases: readonly string[];
  /**
   * The prefix then every alias — what a name-SPACE test reads ("is this a
   * name of the kind's namespace?") where a full-shape test is not wanted.
   */
  readonly prefixes: readonly string[];
  /** Whether {@link parse} upgrades a bare uuid to `<prefix>-<uuid>`. */
  readonly legacyBareUuid: boolean;
  /**
   * The kind's INLINE shape, unanchored and with no `g` flag — a fragment to
   * compose, not a matcher: the kind's own prefix with the generic body,
   * ALIASES EXCLUDED (an alias is ambiguous in prose; see {@link aliases}).
   * Its only built-in guard is a leading one (no letter, digit, `_` or `-`
   * right before the prefix), so `xtask-…` is not an id. Inline readings
   * (chips, `detectIds`) wrap it in `inlineBoundary()`.
   */
  readonly pattern: RegExp;
  /**
   * {@link pattern} plus every alias (with the alias-only suffix-less
   * `<alias>-<epoch>` body) — for an ANCHORED reading where the kind is known
   * from context. {@link is} is this, anchored. Never compose it into inline
   * detection.
   */
  readonly recognitionPattern: RegExp;
  readonly mint: MintFn<P, S>;
  /**
   * Is this WHOLE string an id of this kind — any recognised form, aliases
   * included (the caller knows the kind it is reading)?
   */
  is(value: string): value is Id<P>;
  /**
   * The boundary parse: the id as an `Id<P>` (aliases accepted, as {@link is}),
   * a bare uuid upgraded to `<prefix>-<uuid>` when the kind is
   * `legacyBareUuid`, else throws {@link IdParseError}.
   */
  parse(value: string): Id<P>;
  /** {@link parse} as a zod schema, for endpoints, route params and config. */
  readonly schema: ZodParser<Id<P>>;
  /**
   * A STORED id of this kind arriving from outside (a route param, a URL, a
   * row of another table) to look a row UP by — branded, not validated. The
   * database is the authority on the ids it holds, and live tables carry rows
   * minted before their kind existed (`crash-…` reports, `<commit>-<ms>`
   * builds), so a lookup must reach them: an unknown key simply finds no row.
   * Never a source for an INSERT — a new id comes from {@link mint}; an id a
   * caller hands you to STORE goes through {@link parse}.
   *
   * A `legacyBareUuid` kind's rows were rewritten to `<prefix>-<uuid>`, so a
   * bare uuid can only be a key from before that rewrite (an old URL, a
   * bookmark): `key` upgrades it the way {@link parse} does, and the lookup
   * finds the rewritten row. Anything else is branded as is.
   */
  key(value: string): Id<P>;
  /**
   * When a STAMPED id of this kind was minted, in epoch milliseconds — the
   * body's epoch read as seconds (≤ 11 digits, the current mint) or millis
   * (12–13 digits, the legacy mints), so ids of both generations order
   * correctly against each other. `undefined` for an id this kind does not
   * recognise or whose body carries no stamp (a uuid or a digest). The one
   * sanctioned reading of a stamp: never `split("-")[1]` an id by hand.
   */
  stampedAtMs(value: string): number | undefined;
}

/** Any declared kind — the element type of a registry. */
export type AnyIdKind = IdKind<string, IdShape>;

function assertPrefix(what: string, value: string): void {
  if (!ID_PREFIX_RE.test(value)) {
    throw new Error(
      `[ids] ${what} ${JSON.stringify(value)} must match ${ID_PREFIX_RE.source} ` +
        "(lowercase, 2–10 chars, no hyphen — the hyphen separates prefix from body).",
    );
  }
}

/** `n` random base36 characters, drawn as one integer and zero-padded. */
function base36Suffix(n: number): string {
  return Math.floor(Math.random() * 36 ** n)
    .toString(36)
    .padStart(n, "0");
}

const BARE_UUID_RE = new RegExp(`^${UUID_BODY}$`);
// The epoch of a stamped body, after the `<prefix>-`: digits then `-<suffix>`
// (or the end, for the alias-only suffix-less form).
const STAMP_RE = /^[a-z0-9]+-(\d{9,13})(?:-|$)/;
const DIGEST_RE = new RegExp(`^${HASH_BODY}$`);

/**
 * Declare an id kind once; its mint, branded type, validation and inline
 * recognition all derive from this.
 *
 * ```ts
 * export const taskId = defineIdKind({ prefix: "task", label: "Task" });
 * taskId.mint();          // Id<"task">, e.g. "task-1791400000-0a9zk2"
 * type TaskId = IdOf<typeof taskId>;
 * ```
 *
 * A prefix must be unique repo-wide (`ids:prefix-unique`), and a kind declared
 * on one runtime's `IdKinds.Kind` must be declared on the other
 * (`ids:kind-both-runtimes`).
 */
export function defineIdKind<
  const P extends string,
  S extends IdShape = "stamped",
>(spec: {
  prefix: P;
  label: string;
  shape?: S;
  aliases?: readonly string[];
  legacyBareUuid?: boolean;
}): IdKind<P, S> {
  const { prefix, label } = spec;
  const shape = (spec.shape ?? "stamped") as S;
  const aliases = spec.aliases ?? [];
  const legacyBareUuid = spec.legacyBareUuid ?? false;

  assertPrefix("prefix", prefix);
  for (const alias of aliases) {
    assertPrefix(`alias of "${prefix}"`, alias);
    if (alias === prefix) {
      throw new Error(`[ids] "${prefix}" lists its own prefix as an alias.`);
    }
  }

  const body = bodyFor(shape);
  const own = `${prefix}-${body}`;
  const legacy =
    aliases.length === 0
      ? ""
      : `|(?:${aliases.join("|")})-(?:${body}|${LEGACY_EPOCH_BODY})`;
  const LEAD = "(?<![A-Za-z0-9_-])";
  const pattern = new RegExp(`${LEAD}(?:${own})`);
  const recognitionPattern = new RegExp(`${LEAD}(?:${own}${legacy})`);
  const anchored = new RegExp(`^(?:${recognitionPattern.source})$`);

  const is = (value: string): value is Id<P> => anchored.test(value);

  const parse = (value: string): Id<P> => {
    if (is(value)) return value;
    if (legacyBareUuid && BARE_UUID_RE.test(value)) {
      return `${prefix}-${value}` as Id<P>;
    }
    throw new IdParseError(prefix, label, value);
  };

  const mintStamped = (): Id<P> =>
    `${prefix}-${Math.floor(Date.now() / 1000)}-${base36Suffix(6)}` as Id<P>;
  const mintUuid = (): Id<P> => `${prefix}-${crypto.randomUUID()}` as Id<P>;
  const mintHash = (digest: string): Id<P> => {
    if (!DIGEST_RE.test(digest)) {
      throw new Error(
        `[ids] a ${label} id digest must be 32–64 lowercase hex chars, got ${JSON.stringify(digest)}`,
      );
    }
    return `${prefix}-${digest}` as Id<P>;
  };
  const mint = (
    shape === "hash" ? mintHash : shape === "uuid" ? mintUuid : mintStamped
  ) as MintFn<P, S>;

  const schema: ZodParser<Id<P>> = z.string().transform((value, ctx) => {
    if (is(value)) return value;
    if (legacyBareUuid && BARE_UUID_RE.test(value)) {
      return `${prefix}-${value}` as Id<P>;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `not a ${label} id (expected \`${prefix}-<id>\`)`,
    });
    return z.NEVER;
  });

  const stampedAtMs = (value: string): number | undefined => {
    if (!is(value)) return undefined;
    const digits = STAMP_RE.exec(value)?.[1];
    if (digits === undefined) return undefined;
    const n = Number(digits);
    return digits.length <= 11 ? n * 1000 : n;
  };

  const key = (value: string): Id<P> =>
    legacyBareUuid && BARE_UUID_RE.test(value)
      ? (`${prefix}-${value}` as Id<P>)
      : (value as Id<P>);

  return Object.freeze({
    prefix,
    label,
    shape,
    aliases,
    prefixes: [prefix, ...aliases],
    legacyBareUuid,
    pattern,
    recognitionPattern,
    mint,
    is,
    parse,
    schema,
    stampedAtMs,
    key,
  });
}
