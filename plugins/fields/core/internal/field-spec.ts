import type { z } from "zod";
import type { FieldType, FieldMeta } from "./types";

// The canonical field atom: bundles the type token (→ UI via the fields
// identity registry), the wire zod fragment, a default, and meta. `type`
// references the local `FieldType`, which fields/core owns; the only import
// that leaves this plugin is zod's own types. Kept named `FieldDef` (established across
// ~40 sites).
export interface FieldDef<T = unknown> {
  readonly type: FieldType<T>;
  /**
   * A field schema parses jsonb / JSON / wire — never a value already of type
   * `T` — so it is input-`unknown` by construction. That is what makes
   * `.default()`, `.catch()`, `.coerce()` and `.transform()` usable inside a
   * field schema.
   */
  readonly schema: z.ZodType<T>;
  /**
   * Output-typed on purpose: `defaultValue` is read as a live `T` throughout
   * the repo (it seeds form values, and in config_v2 it *is* the config value).
   * Always a value the schema accepts: `defineField` and
   * `fieldSchemaWithDefault` assert `schema.safeParse(defaultValue)`, so an
   * invalid default fails loudly at definition time, never at a read. A field
   * with no meaningful default has none ({@link DefaultlessFieldDef}).
   */
  readonly defaultValue: T;
  /**
   * `true` on a field that has NO default ({@link DefaultlessFieldDef}): a
   * missing key fails to parse instead of healing to a stand-in, and its
   * `defaultValue` throws when read.
   */
  readonly defaultless?: true;
  /**
   * `true` when the author DECLARED the default (`intField({ default: 0 })`),
   * absent when `defaultValue` is the factory's implicit backfill (`0`, `""`,
   * `new Date(0)`). Only a declared default means something about missing
   * data: an extension's exposed field reads it where the side row is missing
   * (entity-extensions), and reads NULL otherwise. Typed by the factory's
   * marks ({@link FieldMarks}), so the two cannot disagree.
   */
  readonly defaultDeclared?: true;
  readonly meta: FieldMeta;
}

/**
 * A field type with no meaningful default (a uuid has no value that is "any
 * uuid"): built by `defineDefaultlessField`, it carries no stand-in. Its
 * `defaultValue` is `never` — reading it is a type smell and, at runtime, a
 * loud throw — and `fieldsToZodObject` leaves its key required. Such a field is
 * therefore always written (a primary key) or wrapped in `nullable()`.
 */
export interface DefaultlessFieldDef<T = unknown> extends FieldDef<T> {
  readonly defaultValue: never;
  readonly defaultless: true;
}

/** A field whose default was declared (see `FieldDef.defaultDeclared`). */
export interface DeclaredDefault {
  readonly defaultDeclared: true;
}

/**
 * A field declared WITH a label (`textField({ label: "Title" })`) — what a
 * list field must be: a live collection's picked and own fields carry one
 * (`network/live`'s `RequireLabel`), so no list shows a field it cannot name.
 */
export interface Labelled {
  readonly meta: { readonly label: string };
}

/**
 * A field declared `filterable: false` — a list derives a filter for every
 * field whose value has a filter domain, and this one opts out.
 */
export interface Unfilterable {
  readonly meta: { readonly filterable: false };
}

/**
 * What a factory's options say about the field it returns, as types: a
 * declared `default` ({@link DeclaredDefault}), a `label` ({@link Labelled}),
 * `filterable: false` ({@link Unfilterable}). A factory takes its options as
 * a `const O` and returns `XFieldDef & FieldMarks<O>`, so the marks are
 * derived from the call itself — an options value typed only `FieldMeta`
 * (its label optional) marks nothing.
 */
export type FieldMarks<O> = (O extends { readonly default: unknown }
  ? undefined extends O["default"]
    ? unknown
    : DeclaredDefault
  : unknown) &
  (O extends { readonly label: string } ? Labelled : unknown) &
  (O extends { readonly filterable: false } ? Unfilterable : unknown);

/**
 * A factory's options as given, refusing a key its options do not have: a
 * `const O` inferred from a literal is not checked for excess properties
 * (a misspelt `defualt` would pass and mark nothing), so the param type is
 * `ExactOptions<O, Allowed>` — every extra key `never`.
 */
export type ExactOptions<O, Allowed> = O & {
  readonly [K in Exclude<keyof O, keyof Allowed>]: never;
};

/**
 * The meta marks a field carries ({@link Labelled}, {@link Unfilterable}) —
 * what a wrapper keeping the field's meta (`nullable`) keeps.
 */
export type MetaMarksOf<D> = (D extends Labelled ? Labelled : unknown) &
  (D extends Unfilterable ? Unfilterable : unknown);

/**
 * The `defaultDeclared` mark for a factory's options: present exactly when
 * the caller passed a `default`. Spread into the frozen field.
 */
export function declaredDefault(opts?: {
  readonly default?: unknown;
}): Partial<DeclaredDefault> {
  return opts?.default !== undefined ? { defaultDeclared: true } : {};
}

export type FieldsRecord = Record<string, FieldDef>;

export type InferFieldValue<F> = F extends FieldDef<infer T> ? T : never;

// The stored form of a field whose column holds another JS value than the
// field's own (its WIRE value): a `bytea` column holds the bytes a base64
// string carries. Type-only — nothing sets it at runtime; the field type's
// storage declares the column's wire form (sql-column `withWire`), so every
// served row encodes the stored value into the field's. Required, not
// optional: an optional phantom would match every field.
declare const storedAs: unique symbol;

/** Marks a field def whose column stores `S` (see `storedAs`). */
export interface StoredAs<S> {
  readonly [storedAs]: S;
}

/** What a field's column stores: its `StoredAs` value, else its own value. */
export type InferStoredValue<F> =
  F extends StoredAs<infer S> ? S : InferFieldValue<F>;

export type InferFieldsObject<F extends FieldsRecord> = {
  [K in keyof F]: InferFieldValue<F[K]>;
};
