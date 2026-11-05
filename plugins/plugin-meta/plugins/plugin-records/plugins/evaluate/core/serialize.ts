/**
 * A barrel's exports as data, and back.
 *
 * An evaluated record stores what importing a barrel produced (its plugin
 * definition: contributions, slots, registrations, config descriptors), so a
 * later build can read it without importing anything. Those values are not all
 * data: a contribution carries its component (a function), its slot (a slot
 * object), its server kind (a symbol), a config descriptor its zod schema. Each
 * such value is written as a MARKER, and revived as a stand-in that behaves the
 * way every generator already reads the live value:
 *
 * - a function → a function with the same `name` (`componentName` reads it;
 *   `JSON.stringify` drops it, exactly as it drops the real one);
 * - a symbol → a symbol with the same description;
 * - a slot → whatever the caller's `slot(identity)` returns (a stub the
 *   record naming resolves);
 * - a Map / Set / Date / RegExp → the same kind of value;
 * - another class instance → a plain object of its own enumerable fields;
 * - what cannot be data — a zod schema, a React element, a cycle, a value
 *   nested past {@link MAX_DEPTH} — → a value that THROWS when read. A reader
 *   that needs one (a check validating a file against a descriptor's schema)
 *   must import the barrel itself; reading a hollow stand-in silently is the
 *   failure this refuses.
 */

/** The marker key. A NUL never starts a key a plugin writes. */
const M = "\u0000";

const MAX_DEPTH = 24;

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export interface SerializeOptions {
  /**
   * A slot's record identity and its `meta` as data, or `undefined` for a
   * value that is no slot.
   */
  slot(value: object): { identity: string; meta: Json } | undefined;
}

export interface ReviveOptions {
  /** The stand-in for the slot with this identity (the same one each time it is asked). */
  slot(identity: string, meta: Json): unknown;
}

function isZodSchema(v: object): boolean {
  const o = v as Record<string, unknown>;
  return "_zod" in o || ("_def" in o && typeof o.safeParse === "function");
}

function isReactElement(v: object): boolean {
  return "$$typeof" in v;
}

/** `value` as JSON, its non-data parts as markers (see the module doc). */
export function serializeValue(value: unknown, opts: SerializeOptions): Json {
  const stack = new Set<object>();
  const walk = (v: unknown, depth: number): Json => {
    if (v === null) return null;
    switch (typeof v) {
      case "string":
      case "boolean":
        return v;
      case "number":
        return Number.isFinite(v) ? v : { [M]: "num", v: String(v) };
      case "undefined":
        return { [M]: "undef" };
      case "bigint":
        return { [M]: "bigint", v: v.toString() };
      case "symbol":
        return { [M]: "sym", v: v.description ?? "" };
      case "function":
      case "object":
        break;
    }
    const obj = v as object;
    const slot = opts.slot(obj);
    if (slot !== undefined)
      return { [M]: "slot", v: slot.identity, m: slot.meta };
    if (stack.has(obj)) return { [M]: "elided", v: "cycle" };
    if (depth >= MAX_DEPTH) return { [M]: "elided", v: "depth" };
    stack.add(obj);
    try {
      if (typeof obj === "function") {
        const props = ownProps(obj, depth);
        return {
          [M]: "fn",
          v: (obj as { name?: string }).name ?? "",
          ...(props ? { p: props } : {}),
        };
      }
      if (isZodSchema(obj)) return { [M]: "elided", v: "zod schema" };
      if (isReactElement(obj)) return { [M]: "elided", v: "React element" };
      if (Array.isArray(obj)) return obj.map((x) => walk(x, depth + 1));
      if (obj instanceof Map)
        return {
          [M]: "map",
          v: [...obj].map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]),
        };
      if (obj instanceof Set)
        return { [M]: "set", v: [...obj].map((x) => walk(x, depth + 1)) };
      if (obj instanceof Date) return { [M]: "date", v: obj.toISOString() };
      if (obj instanceof RegExp)
        return { [M]: "re", v: obj.source, f: obj.flags };
      const proto = Object.getPrototypeOf(obj) as object | null;
      const plain = proto === null || proto === Object.prototype;
      const props = ownProps(obj, depth) ?? {};
      return plain ? props : { [M]: "obj", v: props };
    } finally {
      stack.delete(obj);
    }
  };
  const ownProps = (
    obj: object,
    depth: number,
  ): { [key: string]: Json } | undefined => {
    const keys = Object.keys(obj);
    if (keys.length === 0) return undefined;
    const out: { [key: string]: Json } = {};
    for (const k of keys) {
      let x: unknown;
      try {
        x = (obj as Record<string, unknown>)[k];
      } catch (err) {
        // A getter that throws on read (a slot's `id` before declaration is
        // non-enumerable, so this is some other lazy value): record that it
        // threw, so a reader of the stand-in throws too.
        out[k] = { [M]: "elided", v: `getter threw: ${String(err)}` };
        continue;
      }
      out[k] = walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** A value that throws on any read — what an elided value revives as. */
function elided(why: string): object {
  const fail = (): never => {
    throw new Error(
      `[plugin-records] this value is not in the record (${why}): a barrel's evaluated record keeps data only. Read it from the imported barrel instead.`,
    );
  };
  return new Proxy(
    {},
    {
      get: (_t, prop) => (prop === Symbol.toStringTag ? "Elided" : fail()),
      has: fail,
      ownKeys: fail,
      getOwnPropertyDescriptor: fail,
    },
  );
}

/** The inverse of {@link serializeValue}, with stand-ins for what was a marker. */
export function reviveValue(json: Json, opts: ReviveOptions): unknown {
  const walk = (j: Json): unknown => {
    if (j === null || typeof j !== "object") return j;
    if (Array.isArray(j)) return j.map(walk);
    const tag = j[M];
    if (typeof tag !== "string") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(j)) out[k] = walk(x);
      return out;
    }
    const v = j.v;
    switch (tag) {
      case "undef":
        return undefined;
      case "num":
        return Number(v);
      case "bigint":
        return BigInt(v as string);
      case "sym":
        return Symbol(v as string);
      case "slot":
        return opts.slot(v as string, j.m as Json);
      case "fn": {
        // A function value with the original's `name`: a component's name is
        // read for docs, and `JSON.stringify` drops it like the real one.
        const stub = {
          [v as string]: () => {
            throw new Error(
              `[plugin-records] function ${JSON.stringify(v)} was read from a record and cannot be called: import the barrel to run it.`,
            );
          },
        }[v as string]!;
        Object.defineProperty(stub, "name", { value: v as string });
        const props = j.p as { [key: string]: Json } | undefined;
        if (props)
          for (const [k, x] of Object.entries(props))
            (stub as unknown as Record<string, unknown>)[k] = walk(x);
        return stub;
      }
      case "map":
        return new Map(
          (v as Json[]).map((e) => {
            const [k, x] = e as [Json, Json];
            return [walk(k), walk(x)];
          }),
        );
      case "set":
        return new Set((v as Json[]).map(walk));
      case "date":
        return new Date(v as string);
      case "re":
        return new RegExp(v as string, j.f as string);
      case "obj": {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as { [key: string]: Json }))
          out[k] = walk(x);
        return out;
      }
      case "elided":
        return elided(v as string);
    }
    throw new Error(`[plugin-records] unknown marker ${JSON.stringify(tag)}`);
  };
  return walk(json);
}
