import { z } from "zod";
import { isAsciiBlank, type FilterScalar } from "./scalars";

// The closed set of filter domains. A filterable column declares a DOMAIN,
// never a field type: the domain owns how a row value is normalized, what
// emptiness means, the operand's wire schema and the SQL type operands bind
// as. Which ops a domain takes is declared on the ops (`ops.ts`), so adding an
// op is one table entry.
//
// Operands are checked against the DOMAIN (any string, any finite number …),
// never against a column's value schema: an operand is not a stored value
// (research/2026-08-27-global-filter-operand-domain.md), so a stale enum
// option in a saved view decodes and matches nothing instead of throwing.

export const FILTER_DOMAIN_IDS = [
  "text",
  "number",
  "boolean",
  "instant",
  "stringArray",
] as const;

export type FilterDomainId = (typeof FILTER_DOMAIN_IDS)[number];

/** A normalized row value: a scalar (instants as epoch ms) or a string set. */
export type FilterValue = FilterScalar | readonly string[];

interface DomainDef {
  /**
   * The SQL type a scalar operand (or a list element) binds as — `P` / `X`
   * render as `$n::<sqlType>`, `L` as `$n::<sqlType>[]`. Explicit, so the
   * comparison runs in the domain's type whatever the target column is (an
   * `integer` column compared with `1.5` stays exact instead of failing to
   * parse the param as an integer).
   */
  readonly sqlType: string;
  /**
   * A row value → its normalized form, or `null` for "no value". Strict:
   * a value of the wrong type throws — answering `false` would hide a
   * declaration bug as "no rows match".
   */
  readonly normalize: (raw: unknown, column: string) => FilterValue | null;
  readonly isEmpty: (value: FilterValue | null) => boolean;
  /** Wire schema of one operand (a list operand's element, for list ops). */
  readonly operand: z.ZodType<FilterScalar>;
  /** The one canonical wire spelling of a parsed operand. */
  readonly canonicalOperand: (operand: FilterScalar) => FilterScalar;
  /** A canonical operand → the scalar its tests compare with. */
  readonly operandValue: (operand: FilterScalar) => FilterScalar;
}

function wrongType(domain: string, column: string, raw: unknown): never {
  throw new Error(
    `filter: "${column}" is declared ${domain}, but a row holds ${describe(raw)}`,
  );
}

function describe(raw: unknown): string {
  if (raw instanceof Date) return `Date(${raw.getTime()})`;
  if (Array.isArray(raw)) return `an array ${JSON.stringify(raw)}`;
  return `a ${typeof raw} ${JSON.stringify(raw)}`;
}

const scalarIsNull = (value: FilterValue | null): boolean => value === null;
const identity = (x: FilterScalar): FilterScalar => x;

// ── Instants ───────────────────────────────────────────────────────────
// ms precision end to end: an operand is an ISO-Z string with at most 3
// fractional digits (its canonical form is `toISOString()`), a row value is a
// `Date` or an ISO-Z string whose fraction is TRUNCATED to ms — which is what
// the pg driver does to a µs `timestamptz` — so a comparison compares
// floor_ms(value) with the operand. The ops' instant SQL states the same
// comparison sargably (see `lte` / `gt` in ops.ts).

const OPERAND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ROW_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/** Epoch ms of a well-formed `YYYY-MM-DDTHH:mm:ss[.fff]Z`, or NaN when a field is out of range. */
function isoMs(base: string, fraction: string): number {
  const ms = Date.parse(`${base}.${fraction.padEnd(3, "0")}Z`);
  // Date.parse rolls some out-of-range fields over (Feb 30 → Mar 2); the
  // round trip catches it.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== base) {
    return Number.NaN;
  }
  return ms;
}

function operandInstantMs(s: string): number {
  if (!OPERAND_INSTANT.test(s)) return Number.NaN;
  const [base, fraction = ""] = s.slice(0, -1).split(".");
  return isoMs(base!, fraction);
}

/** A validated instant operand's epoch ms — throws on anything the operand schema refuses. */
function instantOperandValue(x: FilterScalar): number {
  const ms = typeof x === "string" ? operandInstantMs(x) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new Error(`filter: ${JSON.stringify(x)} is not an instant operand`);
  }
  return ms;
}

const instantOperand = z
  .string()
  .refine((s) => !Number.isNaN(operandInstantMs(s)), {
    message:
      "an instant operand is an ISO-8601 UTC string with at most ms precision (YYYY-MM-DDTHH:mm:ss.sssZ)",
  });

function normalizeInstant(raw: unknown, column: string): number | null {
  if (raw === null) return null;
  if (raw instanceof Date) {
    const ms = raw.getTime();
    if (Number.isNaN(ms)) wrongType("instant", column, raw);
    return ms;
  }
  if (typeof raw === "string") {
    const m = ROW_INSTANT.exec(raw);
    const ms = m ? isoMs(m[1]!, (m[2] ?? "").slice(0, 3)) : Number.NaN;
    if (Number.isNaN(ms)) wrongType("instant", column, raw);
    return ms;
  }
  return wrongType("instant", column, raw);
}

// ── The table ──────────────────────────────────────────────────────────

export const filterDomains: Readonly<Record<FilterDomainId, DomainDef>> = {
  text: {
    sqlType: "text",
    normalize: (raw, column) =>
      raw === null || typeof raw === "string"
        ? raw
        : wrongType("text", column, raw),
    // NULL, or nothing but ASCII whitespace (the C locale's [[:space:]]).
    isEmpty: (value) => value === null || isAsciiBlank(value as string),
    operand: z.string(),
    canonicalOperand: identity,
    operandValue: identity,
  },
  number: {
    sqlType: "float8",
    normalize: (raw, column) =>
      raw === null || (typeof raw === "number" && Number.isFinite(raw))
        ? raw
        : wrongType("number", column, raw),
    isEmpty: scalarIsNull,
    operand: z.number().finite(),
    // JSON cannot spell -0, and Postgres' float8 has 0 = -0.
    canonicalOperand: (x) => (x === 0 ? 0 : x),
    operandValue: identity,
  },
  boolean: {
    sqlType: "boolean",
    normalize: (raw, column) =>
      raw === null || typeof raw === "boolean"
        ? raw
        : wrongType("boolean", column, raw),
    isEmpty: scalarIsNull,
    operand: z.boolean(),
    canonicalOperand: identity,
    operandValue: identity,
  },
  instant: {
    sqlType: "timestamptz",
    normalize: normalizeInstant,
    isEmpty: scalarIsNull,
    operand: instantOperand,
    canonicalOperand: (x) => new Date(instantOperandValue(x)).toISOString(),
    operandValue: instantOperandValue,
  },
  stringArray: {
    // The element type: list operands bind as text[].
    sqlType: "text",
    // A jsonb column: anything that is not an array (a scalar, an object,
    // JSON null) reads as "no set" — empty, and matching no positive op, as
    // the SQL's `jsonb_typeof(T) = 'array'` guards answer. An array holding a
    // non-string is a declaration bug and throws.
    normalize: (raw, column) => {
      if (!Array.isArray(raw)) return null;
      for (const el of raw as unknown[]) {
        if (typeof el !== "string") wrongType("stringArray", column, raw);
      }
      return raw as readonly string[];
    },
    isEmpty: (value) =>
      value === null || (value as readonly string[]).length === 0,
    operand: z.string(),
    canonicalOperand: identity,
    operandValue: identity,
  },
};
