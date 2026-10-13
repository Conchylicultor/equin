import { z } from "zod";
import type {
  FieldDef,
  FieldsRecord,
  InferFieldValue,
} from "@plugins/fields/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

// An extension EXPOSES fields: it declares, once, which of its own fields every
// list of its parent entity (or of an entity reaching it) shows, filters and
// groups by — with the label, the presentation of each value, and what a
// parent with NO side row reads (`absent`: an extension row that does not exist
// means a value, e.g. `tasks_ext_track` stores only `"sidequest"` and a missing
// row is `"main"`). The list names nothing: a collection declares which
// entities it reaches (`network/live`'s `liveCollection({ exposes })`), and
// every exposure of those entities folds in.

/** What a parent with no side row reads for an exposed field: a literal the wire carries, or NULL. */
export type ExposedAbsent = string | number | boolean | null;

/** How one value of an exposed field presents (a `FieldOption`'s presentation). */
export interface ExposedOption {
  readonly label: string;
  /** The chip tint; absent ⇒ muted. */
  readonly variant?: BadgeVariant;
  /** The chip's tooltip — why this value means what it means. */
  readonly hint?: string;
}

/** One exposed field, as declared on the shape (`exposes.fields[f]`). */
export interface ExposedFieldDecl {
  /** The field's label in every list. */
  label: string;
  /** What a parent with no side row reads (see {@link ExposedAbsent}). */
  absent: ExposedAbsent;
  /** Each value's presentation — an enum field's options. */
  options?: Readonly<Record<string, ExposedOption>>;
}

/** The `exposes` of an extension shape: its parent entity, its name, the fields it exposes. */
export interface ExposesDecl {
  /** The parent entity — `defineExtension` asserts it is the parent table. */
  parent: EntityRef;
  /** The extension's name — `defineExtension`'s `name`, asserted equal. */
  name: string;
  fields: { readonly [field: string]: ExposedFieldDecl };
}

/** An exposed field's wire value: the stored value, widened by `absent`. */
type ExposedWire<
  F extends FieldsRecord,
  X extends ExposesDecl,
  K,
> = K extends keyof F & keyof X["fields"]
  ? InferFieldValue<F[K]> | NonNullable<X["fields"][K]>["absent"]
  : never;

/** The exposed slice as a row: each exposed field → its wire value. */
export type ExposureRow<F extends FieldsRecord, X extends ExposesDecl> = {
  [K in keyof X["fields"] & keyof F & string]: ExposedWire<F, X, K>;
};

/**
 * What tsc checks of an `exposes` beyond its loose bound: every exposed key is
 * an own WIRE field (a server-only field, a timestamp or a field that does not
 * exist is `never`), and an `options` record names exactly the field's wire
 * values (for a string field: `"main" | "sidequest"` for track, whose stored
 * schema holds only `"sidequest"`).
 */
export type ExposesCheck<
  F extends FieldsRecord,
  S extends string,
  X extends ExposesDecl,
> = {
  fields: {
    [K in keyof X["fields"]]: K extends Exclude<keyof F & string, S>
      ? {
          absent: InferFieldValue<F[K]> | ExposedAbsent;
          options?: Readonly<
            Record<Extract<ExposedWire<F, X, K>, string>, ExposedOption>
          >;
        }
      : never;
  };
};

/** One exposed field, resolved: what every reader of the exposure reads. */
export interface ExposedField<W = unknown> {
  readonly label: string;
  /** The field TYPE's id (`fields`' type token: `"text"`, `"int"`, `"date"`, …). */
  readonly typeId: string;
  /** The wire schema: the field's own, widened by `absent`. */
  readonly wire: ZodParser<W>;
  readonly absent: ExposedAbsent;
  readonly options: Readonly<Record<string, ExposedOption>> | null;
}

/** A zod OBJECT schema of `R`, its keys readable (what a live column set parses a slice with). */
export type ExposureRowSchema<R> = ZodParser<R> & {
  readonly shape: { readonly [K in keyof R]-?: unknown };
};

/**
 * An extension's exposure: its parent entity, its SLICE — the extension's
 * table name, `<parent>_ext_<name>`, which names it wherever it is read (a
 * join alias, a `$columns` key, a wire-name prefix) — and its fields.
 */
export interface EntityExposure<
  R extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: "exposure";
  readonly parent: EntityRef;
  readonly name: string;
  /** `<parent>_ext_<name>`: the extension's table name. */
  readonly slice: string;
  readonly fields: { readonly [K in keyof R & string]: ExposedField<R[K]> };
  /** The slice as a row: every exposed field's wire schema. */
  readonly row: ExposureRowSchema<R>;
}

/**
 * Resolve a shape's `exposes` against its own fields (`fields` — the plugin's
 * own, not the full record) and server-only keys. Every misuse tsc already
 * rejects is re-checked here for an untyped caller: a key that is not an own
 * wire field, an empty label, an `absent` the field cannot be widened by.
 */
export function resolveExposure(
  key: string,
  fields: FieldsRecord,
  serverOnly: readonly string[],
  exposes: ExposesDecl,
): EntityExposure {
  const fail = (message: string): never => {
    throw new Error(
      `defineExtensionShape({ key: "${key}" }).exposes("${exposes.name}"): ${message}`,
    );
  };
  if (exposes.parent?.kind !== "entity") {
    fail("`parent` is not an EntityRef (`entityRef(name)`).");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(exposes.name)) {
    fail(
      "`name` is the extension's name (`defineExtension`'s), lower snake case.",
    );
  }
  const resolved: Record<string, ExposedField> = {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [f, decl] of Object.entries(exposes.fields)) {
    const field: FieldDef | undefined = Object.hasOwn(fields, f)
      ? fields[f]
      : undefined;
    if (field === undefined)
      fail(`"${f}" is not one of the extension's own fields.`);
    if (serverOnly.includes(f)) {
      fail(`"${f}" is server-only — an exposed field reaches the wire.`);
    }
    if (decl.label.trim().length === 0) fail(`"${f}" has an empty label.`);
    const own = field!.schema as unknown as z.ZodTypeAny;
    const { absent } = decl;
    const wire =
      absent === null
        ? own.nullable()
        : own.safeParse(absent).success
          ? own
          : z.union([own, z.literal(absent)]);
    resolved[f] = Object.freeze({
      label: decl.label,
      typeId: field!.type.id,
      wire: wire as ZodParser<unknown>,
      absent,
      options:
        decl.options === undefined ? null : Object.freeze({ ...decl.options }),
    });
    shape[f] = wire;
  }
  if (Object.keys(resolved).length === 0) {
    fail("`fields` is empty — an exposure exposes at least one field.");
  }
  return Object.freeze({
    kind: "exposure",
    parent: exposes.parent,
    name: exposes.name,
    slice: `${exposes.parent.name}_ext_${exposes.name}`,
    fields: Object.freeze(resolved),
    row: z.object(shape) as unknown as ExposureRowSchema<
      Record<string, unknown>
    >,
  });
}
