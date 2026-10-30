// The repo-owned model of a zod schema: ONE level of it, in zod 4's terms.
// The backend (backend-v4.ts) normalises into it, so a consumer switching on `kind` never reads `_def` /
// `_zod`, and a kind zod adds is a `never`-switch error here, not a silent miss
// in each consumer.
//
// A node is SHALLOW: its children are the raw schemas (`Schema`), handed back
// to `inspect` by whoever walks them. Recursion, memoisation and cycle cutting
// (a `lazy`'s getter returns the schema that holds it) are the walker's, keyed
// on the schema objects themselves.

/**
 * A zod schema, opaque to consumers: pass it back to `inspect`.
 */
export type Schema = object;

/**
 * A check a schema carries, normalised:
 *
 * - `size` — a length (string, array) or size (set, file) bound. `exact` is
 *   `.length(n)`; a set's `.size(n)` is spelled `min` + `max`.
 * - `range` — a number, bigint or date bound (`.min` / `.gt` / `.positive` …);
 *   a date's value is its epoch milliseconds.
 * - `multipleOf` — `.multipleOf(n)` / `.step(n)`.
 * - `numberFormat` — `.int()` (`"safeint"`), `int32` / `uint32` / `float32`
 *   / `float64` / `int64` / `uint64`.
 * - `format` — a string format, in zod 4's names (`email`, `uuid`, `regex`,
 *   `starts_with`, `datetime`, `ipv4`, …), with the parameters that change what it
 *   accepts or produces (every format's `pattern`, `includes` → `includes` +
 *   `position`, `starts_with` → `prefix`, `datetime` → `precision` / `offset` /
 *   `local`, `url` → `hostname` / `protocol` / `normalize`, …). `rewrites`:
 *   the format also REPLACES the value it accepts (`url` trims it, and with
 *   `normalize` hands back `url.href`) — a built-in rewrite its params fully
 *   state, unlike a `rewrite` check. A custom format's test function
 *   (`z.stringFormat(name, fn)`) is a `refine` check beside it.
 * - `mimeType` — a file's accepted types.
 * - `refine` — a test that never changes the value: `.refine`,
 *   `.superRefine`, `.check(fn)`, `z.custom`'s function.
 * - `rewrite` — a check that REPLACES the value: `.trim()`,
 *   `.toLowerCase()`, `.toUpperCase()`, `.normalize()`, `.overwrite(fn)`. zod 4
 *   implements them all as one opaque function, so which one is not known.
 */
export type SchemaCheck =
  | {
      readonly kind: "size";
      readonly bound: "min" | "max" | "exact";
      readonly value: number;
    }
  | {
      readonly kind: "range";
      readonly bound: "min" | "max";
      readonly value: number | bigint;
      readonly inclusive: boolean;
    }
  | { readonly kind: "multipleOf"; readonly value: number | bigint }
  | { readonly kind: "numberFormat"; readonly format: string }
  | {
      readonly kind: "format";
      readonly format: string;
      readonly params: Readonly<Record<string, FormatParam>>;
      readonly rewrites: boolean;
    }
  | { readonly kind: "mimeType"; readonly mime: readonly string[] }
  | { readonly kind: "refine" }
  | { readonly kind: "rewrite" };

/** A string-format parameter: a regex is its `/source/flags` text. */
export type FormatParam = string | number | boolean | null;

/** A template literal's literal part. */
export type TemplateLiteralPart =
  string | number | bigint | boolean | null | undefined;

/** A literal's value. */
export type SchemaLiteral =
  string | number | bigint | boolean | symbol | null | undefined;

/**
 * What an object does with a key its shape does not name:
 * `strip` (dropped — zod's default), `strict` (refused), `opaque` (kept as
 * is — `.passthrough()` / `.loose()`, or a catchall of `unknown` / `any`), or
 * `{ catchall }` (each parsed by that schema — a record of the extra keys).
 */
export type UnknownKeys =
  "strip" | "strict" | "opaque" | { readonly catchall: Schema };

/** The leaf kinds with no parameter beyond their checks. */
export type SchemaLeafKind =
  | "symbol"
  | "undefined"
  | "null"
  | "void"
  | "never"
  | "any"
  | "unknown"
  | "nan"
  | "file";

/** The wrappers over one inner schema with no parameter of their own. */
export type SchemaInnerKind =
  | "optional"
  | "nullable"
  | "readonly"
  | "nonoptional"
  | "promise"
  | "success"
  | "lazy";

interface NodeBase {
  /** The schema this node describes (the one handed to `inspect`). */
  readonly schema: Schema;
  /** Its checks, in declaration order. */
  readonly checks: readonly SchemaCheck[];
}

/**
 * One level of a zod schema: `.refine` is a check on the refined schema
 * (never a wrapper), `.transform` a `pipe` into a `transform`, `z.preprocess`
 * a `pipe` out of one, `.brand` nothing at all, `.passthrough()` an `opaque`
 * object, `z.custom` an `any` with a `refine` check.
 */
export type SchemaNode =
  | (NodeBase & {
      readonly kind: "string";
      readonly coerce: boolean;
      /** The longest it may be (`.max` / `.length`), when capped. */
      readonly max: number | undefined;
    })
  | (NodeBase & {
      readonly kind: "number" | "bigint" | "boolean" | "date";
      readonly coerce: boolean;
    })
  | (NodeBase & { readonly kind: SchemaLeafKind })
  | (NodeBase & {
      readonly kind: "literal";
      readonly values: readonly SchemaLiteral[];
    })
  | (NodeBase & {
      readonly kind: "enum";
      /** Name → value, a numeric native enum's reverse mappings dropped. */
      readonly entries: Readonly<Record<string, string | number>>;
      readonly values: readonly (string | number)[];
    })
  | (NodeBase & {
      readonly kind: "object";
      readonly shape: Readonly<Record<string, Schema>>;
      readonly unknownKeys: UnknownKeys;
    })
  | (NodeBase & {
      readonly kind: "array" | "set";
      readonly element: Schema;
      /** The most items it may hold (`.max` / `.length` / `.size`), when capped. */
      readonly max: number | undefined;
    })
  | (NodeBase & {
      readonly kind: "record";
      readonly key: Schema;
      readonly value: Schema;
      /**
       * `strict` — a key the key schema refuses is an error (`z.record`);
       * `loose` — it is kept as is (`z.looseRecord`), so a finite key schema
       * does NOT bound the record.
       */
      readonly mode: "strict" | "loose";
      /** `z.partialRecord`: a finite key set's keys may be missing (not exhaustive). */
      readonly partial: boolean;
    })
  | (NodeBase & {
      readonly kind: "map";
      readonly key: Schema;
      readonly value: Schema;
      /** The most entries it may hold (`.max` / `.size`), when capped. */
      readonly max: number | undefined;
    })
  | (NodeBase & {
      readonly kind: "tuple";
      readonly items: readonly Schema[];
      /** The `.rest()` schema, or null for a fixed-length tuple. */
      readonly rest: Schema | null;
    })
  | (NodeBase & {
      readonly kind: "union";
      readonly options: readonly Schema[];
      /** A discriminated union's key, else undefined. */
      readonly discriminator: string | undefined;
      /**
       * Whether a value more than one option accepts is accepted: true for
       * `z.union`, false for `z.xor` and a discriminated union.
       */
      readonly inclusive: boolean;
      /** A discriminated union that falls back to trying every option (`unionFallback`). */
      readonly unionFallback: boolean;
    })
  | (NodeBase & {
      readonly kind: "intersection";
      readonly left: Schema;
      readonly right: Schema;
    })
  | (NodeBase & {
      readonly kind: "pipe";
      readonly in: Schema;
      readonly out: Schema;
      /**
       * A codec (`z.codec(in, out, { decode, encode })`, `z.stringbool()`):
       * the pipe itself holds the function from `in`'s output to `out`'s
       * input, so its value is a function body's.
       */
      readonly codec: boolean;
    })
  | (NodeBase & {
      readonly kind: "template_literal";
      /**
       * Its parts in order: a literal is spelled as is, a schema part is a
       * raw schema. Not children ({@link SchemaChild}): a part is a piece of
       * one string, not a value the schema holds.
       */
      readonly parts: readonly (Schema | TemplateLiteralPart)[];
    })
  | (NodeBase & {
      readonly kind: "function";
      /**
       * Its argument and return schemas. Not children: a function's
       * signature, not a value it holds.
       */
      readonly input: Schema;
      readonly output: Schema;
    })
  /** A function step: its output is whatever the function returns. */
  | (NodeBase & {
      readonly kind: "transform";
      /** The function itself — data only when this plugin minted it (`describedFn`). */
      readonly fn: unknown;
    })
  | (NodeBase & {
      readonly kind: "catch";
      readonly inner: Schema;
      /** The function of the failed parse — data only when this plugin minted it (`describedFn`). */
      readonly catchValue: unknown;
    })
  | (NodeBase & {
      readonly kind: "default" | "prefault";
      readonly inner: Schema;
      /** The value filled in for `undefined` (a fresh one per call when the schema computes it). */
      readonly defaultValue: () => unknown;
    })
  | (NodeBase & { readonly kind: SchemaInnerKind; readonly inner: Schema });

export type SchemaKind = SchemaNode["kind"];

/** The node of one kind (the member whose `kind` admits `K`). */
export type SchemaNodeOf<K extends SchemaKind> = NodeOf<SchemaNode, K>;
type NodeOf<N, K> = N extends { readonly kind: infer NK }
  ? K extends NK
    ? N
    : never
  : never;

/** How a child hangs off its parent node. */
export type SchemaEdge =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "catchall" }
  | { readonly kind: "element" }
  | { readonly kind: "keyType" }
  | { readonly kind: "valueType" }
  | { readonly kind: "item"; readonly index: number }
  | { readonly kind: "rest" }
  | { readonly kind: "option"; readonly index: number }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "in" }
  | { readonly kind: "out" }
  | { readonly kind: "inner" };

/** A node's child: the edge it hangs by and its schema. */
export interface SchemaChild {
  readonly edge: SchemaEdge;
  readonly schema: Schema;
}
