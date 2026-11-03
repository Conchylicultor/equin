// ONE spelling per structured param. A live value whose question is a typed
// object (`liveValue(key, { query })`) sends it as ONE string param, and two
// spellings of one question would name two tuples — two loads, and a notify
// that reaches one while the other stays on screen. So both ends encode it the
// same way, here: object keys sorted at every depth, arrays in their order, and
// nothing that is not plain JSON — a value that does not survive a JSON round
// trip unchanged has no canonical spelling, so it throws rather than encode as
// something else (`undefined` in an array → `null`, `NaN` → `null`, a `Date`
// → its ISO string, a class instance → its own fields).
//
// An object property whose value is `undefined` is ABSENT (as `JSON.stringify`
// has it): `{ a: 1, b: undefined }` and `{ a: 1 }` are one question.

/**
 * The canonical JSON text of `value`: keys sorted (code-unit order) at every
 * depth, no whitespace. Throws on anything that is not plain JSON — a
 * non-finite number, `undefined` (top-level or in an array), a function,
 * symbol or bigint, a non-plain object (`Date`, `Map`, a class instance), or
 * a cycle.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

function encode(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) refuse(path, String(value));
      return JSON.stringify(value);
    case "object":
      break;
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return refuse(path, typeof value);
  }
  if (stack.has(value)) refuse(path, "a cycle");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i];
        if (item === undefined) refuse(`${path}[${i}]`, "undefined");
        items.push(encode(item, `${path}[${i}]`, stack));
      }
      return `[${items.join(",")}]`;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      refuse(path, `a ${value.constructor?.name ?? "non-plain"} object`);
    }
    const record = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v === undefined) continue;
      fields.push(
        `${JSON.stringify(key)}:${encode(v, `${path}.${key}`, stack)}`,
      );
    }
    return `{${fields.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function refuse(path: string, what: string): never {
  throw new Error(
    `canonicalJson: ${what} at ${path} is not plain JSON — it has no canonical spelling.`,
  );
}
