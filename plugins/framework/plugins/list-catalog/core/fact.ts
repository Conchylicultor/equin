import type { ReactElement } from "react";

/**
 * A list entry's FACT: its plain-data half. An entry of a list (an app, a
 * theme, a sidebar item) is a fact plus the code behind it, written together
 * by its plugin. The build runs every plugin's declarations once, writes each
 * entry's fact into the catalog, and marks where a field is code; the code
 * stays in the plugin. Whether a field is a fact is decided by what it IS —
 * a function, a component, a React element, a class instance, a schema is
 * code; strings, numbers, booleans, null, arrays and plain objects of them are
 * data — never by a flag.
 *
 * The one rule is {@link factOf}, run by the build (over the records of every
 * plugin barrel) and by the page (over the live entries, to check the catalog
 * it was shipped), so both judge "data" the same way. Its type twin is
 * {@link Fact}: a field that is code does not exist on it, so reading code
 * from a fact is a compile error.
 */

/** Where a field of a fact is code: the field's value in the catalog. */
export interface CodeMarker {
  readonly $code: true;
}

/** The marker, as written into the catalog (canonical JSON `{"$code":true}`). */
export const CODE: CodeMarker = Object.freeze({ $code: true });

/** Whether a catalog value is the code marker. */
export function isCodeMarker(value: unknown): value is CodeMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $code?: unknown }).$code === true &&
    Object.keys(value).length === 1
  );
}

/**
 * The bookkeeping a contribution carries that is not part of its entry: its
 * list (`_slot`, `_kind`), its doc label, the plugin stamps. Never in a fact
 * (the catalog names the list and the plugin beside it).
 */
const BOOKKEEPING = new Set([
  "_slot",
  "_kind",
  "_doc",
  "_pluginId",
  "_pluginDescription",
]);

/** A value of an entry that cannot be written down as data at all. */
export class NotDataError extends Error {
  override name = "NotDataError";
  constructor(
    readonly path: string,
    readonly what: string,
  ) {
    super(`${path} is ${what}, which cannot be written down as data`);
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}

/**
 * A record's elided value (a zod schema, a React element, a cycle) reads as
 * nothing but its tag — code on the build's side, as the live value is on the
 * page's.
 */
function isElided(value: object): boolean {
  return Object.prototype.toString.call(value) === "[object Elided]";
}

function isReactElement(value: object): boolean {
  return "$$typeof" in value;
}

function isZodSchema(value: object): boolean {
  return "_zod" in value || "_def" in value;
}

/**
 * One field of an object, read. A getter that throws when read (a field type's
 * `defaultValue` that has none) is code: what it is takes running the
 * plugin's code, and the build's record keeps exactly that (an elided value),
 * so both sides answer the code marker.
 */
function readField(
  obj: object,
  key: string,
): { kind: "value"; value: unknown } | { kind: "code" } {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc?.get === undefined)
    return { kind: "value", value: (obj as Record<string, unknown>)[key] };
  try {
    return { kind: "value", value: desc.get.call(obj) };
  } catch (err) {
    if (err instanceof Error) return { kind: "code" };
    throw err;
  }
}

/**
 * `entry` as its fact (a slot — a callable on the page, a callable stand-in in
 * a record — is code like any function): plain data, every code field the {@link CODE} marker,
 * object keys sorted (so the catalog's JSON is canonical), bookkeeping fields
 * dropped and `undefined` fields left out. Throws {@link NotDataError} for a
 * value that is neither data nor code — a number that is not finite, an
 * `undefined` or a hole inside an array, a cycle — naming where (`where`
 * prefixes the path). Such an entry cannot be written down, and a fact
 * written wrong is worse than a build that fails.
 */
export function factOf(entry: object, where: string): Record<string, unknown> {
  const stack = new Set<object>();
  const walk = (value: unknown, path: string): unknown => {
    if (value === null) return null;
    switch (typeof value) {
      case "string":
      case "boolean":
        return value;
      case "number":
        if (Number.isFinite(value)) return value;
        throw new NotDataError(path, `the number ${String(value)}`);
      case "undefined":
        throw new NotDataError(path, "undefined inside an array");
      case "bigint":
      case "symbol":
      case "function":
        return CODE;
      case "object":
        break;
    }
    const obj = value as object;
    // Elided first: a record's elided value throws on any other read.
    if (isElided(obj) || isReactElement(obj) || isZodSchema(obj)) return CODE;
    if (Array.isArray(obj)) {
      if (stack.has(obj)) throw new NotDataError(path, "a cycle");
      stack.add(obj);
      const out: unknown[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw new NotDataError(`${path}[${i}]`, "a hole");
        out.push(walk(obj[i], `${path}[${i}]`));
      }
      stack.delete(obj);
      return out;
    }
    // A class instance (a Map, a Date, a store) is code: what it is depends
    // on its class, which only the plugin's code holds.
    if (!isPlainObject(obj)) return CODE;
    if (stack.has(obj)) throw new NotDataError(path, "a cycle");
    stack.add(obj);
    const out = fields(obj, path);
    stack.delete(obj);
    return out;
  };
  const fields = (obj: object, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const read = readField(obj, key);
      if (read.kind === "code") {
        out[key] = CODE;
        continue;
      }
      if (read.value === undefined) continue;
      out[key] = walk(read.value, `${path}.${key}`);
    }
    return out;
  };
  const top: Record<string, unknown> = {};
  for (const key of Object.keys(entry).sort()) {
    if (BOOKKEEPING.has(key)) continue;
    top[key] = (entry as Record<string, unknown>)[key];
  }
  return fields(top, where);
}

/** {@link factOf} as canonical JSON — what the catalog holds, and compares. */
export function factJson(entry: object, where: string): string {
  return JSON.stringify(factOf(entry, where));
}

// ── The type twin ────────────────────────────────────────────────────────────

/** What {@link factOf} writes as the code marker, told apart at the type level. */
type CodeValue =
  | ((...args: never[]) => unknown)
  | (abstract new (...args: never[]) => unknown)
  | ReactElement
  | bigint
  | symbol
  | { readonly _zod: unknown }
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | Date
  | RegExp
  | Promise<unknown>;

type IsAny<T> = 0 extends 1 & T ? true : false;

/** One value of a fact (below the entry): data as is, code as the marker. */
export type FactValue<T> =
  IsAny<T> extends true
    ? T
    : T extends CodeValue
      ? CodeMarker
      : T extends string | number | boolean | null | undefined
        ? T
        : T extends readonly (infer U)[]
          ? T extends unknown[]
            ? FactValue<U>[]
            : readonly FactValue<U>[]
          : T extends object
            ? FactFields<T>
            : T;

/** The keys of `T` whose every value is code: they do not exist on the fact. */
type CodeKeys<T> = {
  [K in keyof T]-?: [Exclude<T[K], undefined>] extends [never]
    ? never
    : [Exclude<T[K], undefined>] extends [CodeValue]
      ? K
      : never;
}[keyof T];

// Key remapping keeps each field's own `readonly` / `?`: a fact of a type is
// assignable back to that type when none of its fields is code.
type FactFields<T> = {
  [K in keyof T as K extends CodeKeys<T> ? never : K]: FactValue<T[K]>;
};

/**
 * The fact of an entry of type `P`, as the catalog holds it: every field that
 * is code is gone (`component`, a callback, a React element), every other
 * field is its data. Reading `fact.component` is a compile error — the code
 * of an entry lives in its plugin, not in its fact.
 *
 * Distributes over a union of entry shapes (an app that opens a tab or switches
 * the surface keeps both arms). A field typed as a class the type cannot see
 * as one (anything but the {@link CodeValue} kinds) is typed as its fields
 * while the catalog holds the marker — the one place the twin is weaker than
 * the rule.
 */
export type Fact<P> = P extends unknown
  ? FactFields<
      Omit<P, "_slot" | "_kind" | "_doc" | "_pluginId" | "_pluginDescription">
    >
  : never;
