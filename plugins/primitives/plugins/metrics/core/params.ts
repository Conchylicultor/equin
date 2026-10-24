import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// The closed set of knobs a metric source can expose (a toggle, a choice, a
// list). A spec is data, so the catalog ships it to the browser as-is and the
// server parses a query's raw values against the very same object.

export type ParamSpec =
  | { readonly kind: "bool"; readonly default: boolean }
  | {
      readonly kind: "enum";
      readonly values: readonly string[];
      readonly default: string;
    }
  | { readonly kind: "stringList"; readonly default: readonly string[] };

export type ParamSpecs = Readonly<Record<string, ParamSpec>>;

export function bool(def: boolean): {
  readonly kind: "bool";
  readonly default: boolean;
} {
  return Object.freeze({ kind: "bool", default: def });
}

export function enumOf<const V extends readonly [string, ...string[]]>(
  values: V,
  def: V[number],
): { readonly kind: "enum"; readonly values: V; readonly default: V[number] } {
  if (!values.includes(def)) {
    throw new Error(
      `enumOf: default "${def}" is not one of ${JSON.stringify(values)}`,
    );
  }
  return Object.freeze({ kind: "enum", values, default: def });
}

export function stringList(def: readonly string[] = []): {
  readonly kind: "stringList";
  readonly default: readonly string[];
} {
  return Object.freeze({
    kind: "stringList",
    default: Object.freeze([...def]),
  });
}

/** The value a spec parses to. */
export type ParamValue<S extends ParamSpec> = S extends { kind: "bool" }
  ? boolean
  : S extends { kind: "enum"; values: infer V extends readonly string[] }
    ? V[number]
    : string[];

export type ParamValues<Specs extends ParamSpecs> = {
  [K in keyof Specs]: ParamValue<Specs[K]>;
};

export type ParseParamsResult<T> =
  { ok: true; values: T } | { ok: false; error: string };

/**
 * Parse a query's raw params against the specs it may name. A missing param
 * takes its default; an unknown name or a value of the wrong type is an error
 * (the handler answers it with a 400), never silently dropped.
 */
export function parseParams<Specs extends ParamSpecs>(
  specs: Specs,
  raw: Readonly<Record<string, unknown>>,
): ParseParamsResult<ParamValues<Specs>> {
  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(specs, name)) {
      return { ok: false, error: `unknown param "${name}"` };
    }
  }
  const values: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined;
    const parsed = parseOne(spec, value);
    if (!parsed.ok) {
      return { ok: false, error: `param "${name}": ${parsed.error}` };
    }
    values[name] = parsed.value;
  }
  return { ok: true, values: values as ParamValues<Specs> };
}

function parseOne(
  spec: ParamSpec,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (value === undefined) {
    return {
      ok: true,
      value: spec.kind === "stringList" ? [...spec.default] : spec.default,
    };
  }
  switch (spec.kind) {
    case "bool":
      return typeof value === "boolean"
        ? { ok: true, value }
        : {
            ok: false,
            error: `expected a boolean, got ${JSON.stringify(value)}`,
          };
    case "enum":
      return typeof value === "string" && spec.values.includes(value)
        ? { ok: true, value }
        : {
            ok: false,
            error: `expected one of ${JSON.stringify(spec.values)}, got ${JSON.stringify(value)}`,
          };
    case "stringList":
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? { ok: true, value: [...(value as string[])] }
        : {
            ok: false,
            error: `expected a list of strings, got ${JSON.stringify(value)}`,
          };
  }
}

/** A spec as the catalog ships it: named, since the wire has no record keys to carry the name. */
/** Why a param spec's lists are loaded whole. */
const PARAM_REASON = "one param spec's values — declared in code";

export const ParamSpecWireSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("bool"), default: z.boolean() }),
  z.object({
    id: z.string(),
    kind: z.literal("enum"),
    values: wholeList(z.string(), { reason: PARAM_REASON }),
    default: z.string(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("stringList"),
    default: wholeList(z.string(), { reason: PARAM_REASON }),
  }),
]);
export type ParamSpecWire = z.infer<typeof ParamSpecWireSchema>;

export function paramSpecsToWire(specs: ParamSpecs): ParamSpecWire[] {
  return Object.entries(specs).map(([id, spec]) =>
    spec.kind === "enum"
      ? { id, kind: "enum", values: [...spec.values], default: spec.default }
      : spec.kind === "stringList"
        ? { id, kind: "stringList", default: [...spec.default] }
        : { id, kind: "bool", default: spec.default },
  );
}
