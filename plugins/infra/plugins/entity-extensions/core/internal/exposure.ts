import { z } from "zod";
import type {
  DeclaredDefault,
  FieldDef,
  FieldOptionMeta,
  FieldsRecord,
  InferFieldValue,
  OptionKey,
} from "@plugins/fields/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

// An extension EXPOSES fields: it declares, once, which of its own fields every
// list of its parent entity (or of an entity reaching it) shows, filters and
// groups by. The list names nothing: a collection declares which entities it
// reaches (`network/live`'s `liveCollection({ exposes })`), and every exposure
// of those entities folds in.
//
// What a parent with NO side row reads is DERIVED, never authored: the field's
// declared default (`enumTextField(TRACKS, { default: "main" })` — a task with
// no track row is main) when it declares one, else NULL — and then the exposed
// wire schema is the field's made nullable, so "no value" can never pass for a
// value. (`defineExtension` asserts a literal DB default agrees, so a missing
// row and a defaulted one read the same.)
//
// Beside its fields, an extension may expose its PRESENCE — a field derived
// from whether the side row exists at all (a page is starred iff it has a
// `starred` row): `exposes.presence: { id, label, values? }`, a boolean, or one
// of two literals (`values: { present: "agent", absent: "user" }`).

/** What a parent with no side row reads for an exposed field: a literal the wire carries, or NULL. */
export type ExposedAbsent = string | number | boolean | null;

/** How one value of an exposed field presents (a field option's presentation). */
export type ExposedOption = FieldOptionMeta;

/** One exposed field, as declared on the shape (`exposes.fields[f]`). */
export interface ExposedFieldDecl {
  /** The field's label in every list; absent ⇒ the field's own (`FieldMeta.label`). */
  label?: string;
  /**
   * The field's id in every list, when it differs from its column's key (a
   * saved view names `status`, the column is `ok`). Absent ⇒ the key.
   */
  as?: string;
  /**
   * Each value's presentation, keyed by its canonical spelling (`optionKey`:
   * `"true"` / `"false"`, `"null"` for what a missing side row reads) — every
   * value of the exposed wire, NULL included (tsc). Absent ⇒ the field's own
   * (`FieldMeta.optionMeta`).
   */
  options?: Readonly<Record<string, ExposedOption>>;
}

/** The two literals a presence field reads, instead of a boolean. */
export interface ExposedPresenceValues {
  /** Read where the side row exists. */
  readonly present: string;
  /** Read where it is missing. */
  readonly absent: string;
}

/** The extension's PRESENCE, exposed as a field (`exposes.presence`). */
export interface ExposedPresenceDecl {
  /** The field's id (its `$columns` key, and what a saved view names). */
  id: string;
  label: string;
  /** Two literals instead of a boolean (`{ present: "agent", absent: "user" }`). */
  values?: ExposedPresenceValues;
  /** Each value's presentation: the two literals', or `"true"` / `"false"` for a boolean. */
  options?: Readonly<Record<string, ExposedOption>>;
}

/** The `exposes` of an extension shape: its parent entity, its name, the fields it exposes. */
export interface ExposesDecl {
  /** The parent entity — `defineExtension` asserts it is the parent table. */
  parent: EntityRef;
  /** The extension's name — `defineExtension`'s `name`, asserted equal. */
  name: string;
  fields?: { readonly [field: string]: ExposedFieldDecl };
  presence?: ExposedPresenceDecl;
}

/** An exposed column field's wire value: the stored value, `| null` unless its default is declared. */
type ExposedValue<
  F extends FieldsRecord,
  K extends keyof F,
> = F[K] extends DeclaredDefault
  ? InferFieldValue<F[K]>
  : InferFieldValue<F[K]> | null;

type FieldsOf<X> = X extends { fields: infer XF } ? XF : Record<never, never>;

/** The presence field's slot in the row: its id → a boolean, or one of its two literals. */
type PresenceRow<X> = X extends { presence: infer P }
  ? P extends { id: infer I extends string }
    ? {
        [Id in I]: P extends {
          values: { present: infer A; absent: infer B };
        }
          ? A | B
          : boolean;
      }
    : Record<never, never>
  : Record<never, never>;

type Flatten<T> = { [K in keyof T]: T[K] };

/** The exposed slice as a row: each exposed field (by column key) → its wire value, and the presence. */
export type ExposureRow<
  F extends FieldsRecord,
  X extends ExposesDecl,
> = Flatten<
  {
    [K in keyof FieldsOf<X> & keyof F & string]: ExposedValue<F, K>;
  } & PresenceRow<X>
>;

/**
 * What tsc checks of an `exposes` beyond its loose bound: every exposed key is
 * an own WIRE field (a server-only field, a timestamp or a field that does not
 * exist is `never`), no field authors what a missing row reads (`absent` —
 * derived from the field's default), and an `options` record names exactly
 * the exposed wire's values by their canonical spelling (`OptionKey`: a
 * nullable field's `"null"` too; a presence's: its two literals, or `"true"` /
 * `"false"`).
 */
export type ExposesCheck<
  F extends FieldsRecord,
  S extends string,
  X extends ExposesDecl,
> = {
  fields?: {
    [K in keyof FieldsOf<X>]: K extends Exclude<keyof F & string, S>
      ? {
          absent?: never;
          options?: Readonly<
            Record<OptionKey<ExposedValue<F, K>>, ExposedOption>
          >;
        }
      : never;
  };
  presence?: X extends {
    presence: {
      values: {
        present: infer A extends string;
        absent: infer B extends string;
      };
    };
  }
    ? { options?: Readonly<Record<A | B, ExposedOption>> }
    : { options?: Readonly<Record<OptionKey<boolean>, ExposedOption>> };
};

/** A presence field's derivation: a boolean (`values: null`), or one of two literals. */
export interface ExposedPresence {
  readonly values: ExposedPresenceValues | null;
}

/** One exposed field, resolved: what every reader of the exposure reads. */
export interface ExposedField<W = unknown> {
  /** Its id in every list — `as`, else its key (the `$columns` key). */
  readonly id: string;
  readonly label: string;
  /** The field TYPE's id (`fields`' type token: `"text"`, `"int"`, `"date"`, …). */
  readonly typeId: string;
  /** The wire schema: the field's own, nullable when a missing row reads NULL. */
  readonly wire: ZodParser<W>;
  /**
   * What a parent with no side row reads — DERIVED: the field's declared
   * default, else NULL (a presence field: `false`, or `values.absent`).
   */
  readonly absent: ExposedAbsent;
  readonly options: Readonly<Record<string, ExposedOption>> | null;
  /** Set on the presence field — a read of the side row's existence, no column. */
  readonly presence: ExposedPresence | null;
}

/** A zod OBJECT schema of `R`, its keys readable (what a live column set parses a slice with). */
export type ExposureRowSchema<R> = ZodParser<R> & {
  readonly shape: { readonly [K in keyof R]-?: unknown };
};

/**
 * An extension's exposure: its parent entity, its SLICE — the extension's
 * table name, `<parent>_ext_<name>`, which names it wherever it is read (a
 * join alias, a `$columns` key, a wire-name prefix) — and its fields, keyed by
 * column key (the presence field by its id).
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

const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Resolve a shape's `exposes` against its own fields (`fields` — the plugin's
 * own, not the full record) and server-only keys. Every misuse tsc already
 * rejects is re-checked here for an untyped caller: a key that is not an own
 * wire field, an `absent`, a missing or empty label, two fields of one id.
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
    fail("`parent` is not an EntityRef (`entityRef(name, fields)`).");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(exposes.name)) {
    fail(
      "`name` is the extension's name (`defineExtension`'s), lower snake case.",
    );
  }
  const resolved: Record<string, ExposedField> = {};
  const shape: Record<string, z.ZodTypeAny> = {};
  const ids = new Map<string, string>();
  const claim = (id: string, by: string): void => {
    if (!ID_RE.test(id)) fail(`${by}'s id "${id}" is not a field id.`);
    const other = ids.get(id);
    if (other !== undefined) fail(`${by} and ${other} share the id "${id}".`);
    ids.set(id, by);
  };
  for (const [f, decl] of Object.entries(exposes.fields ?? {})) {
    const field: FieldDef | undefined = Object.hasOwn(fields, f)
      ? fields[f]
      : undefined;
    if (field === undefined)
      return fail(`"${f}" is not one of the extension's own fields.`);
    if (serverOnly.includes(f)) {
      fail(`"${f}" is server-only — an exposed field reaches the wire.`);
    }
    if (Object.hasOwn(decl, "absent")) {
      fail(
        `"${f}" declares \`absent\` — what a missing side row reads is derived: the field's declared default (\`${field.type.id}Field({ default })\`), else NULL.`,
      );
    }
    const label = decl.label ?? field.meta.label;
    if (label === undefined || label.trim().length === 0) {
      fail(
        `"${f}" has no label — give the field one (\`{ label }\`) or the exposure (\`fields.${f}.label\`).`,
      );
    }
    const id = decl.as ?? f;
    claim(id, `field "${f}"`);
    const own = field.schema as unknown as z.ZodTypeAny;
    const absent = field.defaultDeclared === true ? field.defaultValue : null;
    if (
      absent !== null &&
      typeof absent !== "string" &&
      typeof absent !== "number" &&
      typeof absent !== "boolean"
    ) {
      fail(
        `"${f}" declares the default ${JSON.stringify(absent)}, which a missing side row cannot read (a string, number or boolean literal) — declare none, and a missing row reads NULL.`,
      );
    }
    const wire = absent === null ? own.nullable() : own;
    const options = decl.options ?? field.meta.optionMeta;
    resolved[f] = Object.freeze({
      id,
      label: label!,
      typeId: field.type.id,
      wire: wire as ZodParser<unknown>,
      absent: absent as ExposedAbsent,
      options: options === undefined ? null : Object.freeze({ ...options }),
      presence: null,
    });
    shape[f] = wire;
  }
  const presence = exposes.presence;
  if (presence !== undefined) {
    const by = `presence "${presence.id}"`;
    claim(presence.id, by);
    if (Object.hasOwn(fields, presence.id)) {
      fail(
        `${by} is named like one of the extension's fields — its id is its \`$columns\` key.`,
      );
    }
    if (presence.label.trim().length === 0) fail(`${by} has an empty label.`);
    const values = presence.values ?? null;
    if (values !== null && values.present === values.absent) {
      fail(`${by} reads "${values.present}" either way.`);
    }
    const keys =
      values === null ? ["true", "false"] : [values.present, values.absent];
    const strays = Object.keys(presence.options ?? {}).filter(
      (k) => !keys.includes(k),
    );
    if (strays.length > 0) {
      fail(
        `${by}'s \`options\` name ${strays.join(", ")} — it reads only ${keys.join(" / ")}.`,
      );
    }
    const wire =
      values === null ? z.boolean() : z.enum([values.present, values.absent]);
    resolved[presence.id] = Object.freeze({
      id: presence.id,
      label: presence.label,
      typeId: values === null ? "bool" : "text",
      wire: wire as ZodParser<unknown>,
      absent: values === null ? false : values.absent,
      options:
        presence.options === undefined
          ? null
          : Object.freeze({ ...presence.options }),
      presence: Object.freeze({
        values: values === null ? null : Object.freeze({ ...values }),
      }),
    });
    shape[presence.id] = wire;
  }
  if (Object.keys(resolved).length === 0) {
    fail(
      "it exposes nothing — an exposure exposes at least one field, or its presence.",
    );
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
