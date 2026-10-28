import {
  peel,
  valueSide,
  type SchemaNode,
} from "@plugins/packages/plugins/zod-introspect/core";
import type {
  FieldDef,
  InferFieldValue,
  Unfilterable,
} from "@plugins/fields/core";
import type {
  FilterColumn,
  FilterDomainId,
} from "@plugins/network/plugins/live/plugins/filter/core";

// The filter domain a field's values read in — the ONE derivation every owner
// of a live field shares (a collection's picked and own fields, an exposure's,
// a run arm's), so a list filters every field the same way. It is read off the
// field's VALUE: at the type level from the value type, at runtime from the
// schema that produces that value — the same fact twice, so the two cannot
// disagree. A value with no domain (an object, a JSON blob) is simply not
// filterable, and `filterable: false` opts a field out.

/** The domain a value of type `V` (NULL aside) reads in; `never` for one with none. */
export type DomainOfValue<V> = [V] extends [never]
  ? never
  : [V] extends [string]
    ? "text"
    : [V] extends [number]
      ? "number"
      : [V] extends [boolean]
        ? "boolean"
        : [V] extends [Date]
          ? "instant"
          : [V] extends [readonly string[]]
            ? "stringArray"
            : never;

/** The operand type a value of type `V` filters by in its domain. */
type OperandOfValue<V> = [V] extends [string]
  ? V
  : [V] extends [number]
    ? number
    : [V] extends [boolean]
      ? boolean
      : [V] extends [Date]
        ? string
        : [V] extends [readonly (infer E)[]]
          ? E
          : never;

/** A field's filter column (its domain and operand type), `never` when it has no domain or opts out. */
export type FieldFilterColumn<D> = D extends Unfilterable
  ? never
  : DomainOfValue<NonNullable<InferFieldValue<D>>> extends infer Dm extends
        FilterDomainId
    ? [Dm] extends [never]
      ? never
      : FilterColumn<Dm, OperandOfValue<NonNullable<InferFieldValue<D>>>>
    : never;

/** The filterable columns of a field record: each field with a domain, by key. */
export type FieldsFilterable<F> = {
  readonly [
    K in keyof F & string as [FieldFilterColumn<F[K]>] extends [never]
      ? never
      : K
  ]: FieldFilterColumn<F[K]>;
};

/**
 * The domain `schema`'s values read in, `null` for none — through every
 * wrapper that keeps the value's type (nullable, optional, default, catch,
 * readonly, brand, a preprocess / refine / transform's input schema, a
 * pipeline's output).
 */
export function schemaDomain(schema: unknown): FilterDomainId | null {
  const node = valueNode(schema);
  if (node.kind === "string") return "text";
  if (node.kind === "enum") {
    return node.values.every((v) => typeof v === "string") ? "text" : null;
  }
  if (node.kind === "literal") return literalDomain(node.values);
  if (node.kind === "union") {
    const options = node.options.map(valueNode);
    if (options.every((o) => o.kind === "literal")) {
      return literalDomain(options.flatMap((o) => o.values));
    }
    const domains = new Set(options.map((o) => schemaDomain(o.schema)));
    return domains.size === 1 ? [...domains][0]! : null;
  }
  if (node.kind === "number") return "number";
  if (node.kind === "boolean") return "boolean";
  if (node.kind === "date") return "instant";
  if (node.kind === "array") {
    return schemaDomain(node.element) === "text" ? "stringArray" : null;
  }
  return null;
}

/** A field's filter domain: its schema's, unless it opts out (`filterable: false`). */
export function fieldDomain(field: FieldDef): FilterDomainId | null {
  if (field.meta.filterable === false) return null;
  return schemaDomain(field.schema);
}

function literalDomain(values: readonly unknown[]): FilterDomainId | null {
  if (values.every((v) => typeof v === "string")) return "text";
  if (values.every((v) => typeof v === "number")) return "number";
  if (values.every((v) => typeof v === "boolean")) return "boolean";
  return null;
}

/**
 * The node a schema's values come from (see {@link schemaDomain}): the
 * value-keeping wrappers peeled, then a pipe's value side or a lazy's target,
 * repeated until neither applies.
 */
function valueNode(schema: unknown): SchemaNode {
  let s = schema;
  for (;;) {
    const { node } = peel(s);
    if (node.kind === "pipe") s = valueSide(node);
    else if (node.kind === "lazy") s = node.inner;
    else return node;
  }
}
