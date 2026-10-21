// A JSON value's change, as what changed. A value that grows — a message
// being streamed, an output tail — changes by a few characters at a few
// places; shipping the whole of it on every change costs the size of the
// value, every time. `diffValue` names the change in terms of the JSON the
// value serializes to; `applyValuePatch` replays it on a copy of the previous
// value that shares every part the change did not touch.

/** Where in a JSON value: object keys and array indices, from the root. */
export type ValuePath = readonly (string | number)[];

/**
 * One change at `at` (`[]` is the root, which may grow but is never `set` —
 * replacing it is the whole value):
 * - `set` — the value there is replaced (or, in an object, added);
 * - `append` — the string there grew by this suffix;
 * - `push` — the array there grew by these elements.
 */
export type ValuePatchOp =
  | { at: ValuePath; set: unknown }
  | { at: ValuePath; append: string }
  | { at: ValuePath; push: readonly unknown[] };

/**
 * An op as it arrives off the wire: exactly one of `set` / `append` / `push`,
 * and a path of keys and indices — checked by `applyValuePatch`, which throws
 * on anything else.
 */
export interface ValuePatchWireOp {
  readonly at: readonly unknown[];
  readonly set?: unknown;
  readonly append?: string;
  readonly push?: readonly unknown[];
}

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The keys JSON keeps: an `undefined` member is absent, as on the wire. */
function jsonKeys(o: JsonObject): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

/** Equal as JSON, for a leaf the walk does not descend into. */
function sameLeaf(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  // A non-plain object (a Date): compared by what it serializes to.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The ops that turn `prev` into `next`, compared as the JSON they serialize
 * to: `[]` when nothing changed, `null` when the root itself is what changed
 * (another kind of value, an object with other keys, a shorter array, a
 * string that did not grow) — the caller ships `next` whole then.
 */
export function diffValue(prev: unknown, next: unknown): ValuePatchOp[] | null {
  const ops: ValuePatchOp[] = [];
  return walk(prev, next, [], ops) ? ops : null;
}

/** Diff `prev` → `next` at `at` into `ops`; false when `at` must be replaced whole. */
function walk(
  prev: unknown,
  next: unknown,
  at: (string | number)[],
  ops: ValuePatchOp[],
): boolean {
  if (prev === next) return true;
  if (typeof prev === "string" && typeof next === "string") {
    if (next.length > prev.length && next.startsWith(prev)) {
      ops.push({ at: [...at], append: next.slice(prev.length) });
      return true;
    }
    return false;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (next.length < prev.length) return false;
    for (let i = 0; i < prev.length; i++) {
      at.push(i);
      const ok = walk(prev[i], next[i], at, ops);
      at.pop();
      if (!ok) ops.push({ at: [...at, i], set: next[i] });
    }
    if (next.length > prev.length)
      ops.push({ at: [...at], push: next.slice(prev.length) });
    return true;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const before = jsonKeys(prev);
    const after = jsonKeys(next);
    // A member gone: nothing but the whole object says so.
    if (before.some((k) => next[k] === undefined)) return false;
    for (const k of after) {
      if (prev[k] === undefined) {
        ops.push({ at: [...at, k], set: next[k] });
        continue;
      }
      at.push(k);
      const ok = walk(prev[k], next[k], at, ops);
      at.pop();
      if (!ok) ops.push({ at: [...at, k], set: next[k] });
    }
    return true;
  }
  if (isPlainObject(prev) || isPlainObject(next)) return false;
  if (Array.isArray(prev) || Array.isArray(next)) return false;
  return sameLeaf(prev, next);
}

/**
 * `base` with `ops` applied, in order. `base` is never mutated: each op copies
 * the containers along its path (once per container per call), so every part
 * of `base` no op reaches is shared by the result. A path `base` does not hold,
 * or an op of the wrong kind for what is there, throws — the patch was made
 * against another value.
 */
export function applyValuePatch(
  base: unknown,
  ops: readonly ValuePatchWireOp[],
): unknown {
  if (ops.length === 0) return base;
  const copied = new Set<unknown>();
  const own = (v: unknown): unknown => {
    if (copied.has(v)) return v;
    if (!Array.isArray(v) && !isPlainObject(v))
      throw new Error(
        "applyValuePatch: a path through a value that is no container",
      );
    const c = Array.isArray(v)
      ? [...(v as unknown[])]
      : { ...(v as JsonObject) };
    copied.add(c);
    return c;
  };
  let root = base;
  for (const op of ops) {
    const kinds = ["set", "append", "push"].filter((k) => k in op);
    if (kinds.length !== 1)
      throw new Error(
        `applyValuePatch: an op names ${kinds.length === 0 ? "no change" : kinds.join(" and ")} at ${pathText(op.at)}`,
      );
    if (op.at.length === 0) {
      // The root grew (a string or an array value); replacing it is no patch.
      root = grown(root, op);
      continue;
    }
    root = own(root);
    let parent = root as JsonObject | unknown[];
    for (let i = 0; i < op.at.length - 1; i++) {
      const key = pathKey(op.at, i);
      const child = readChild(parent, key, op.at);
      const mine = own(child) as JsonObject | unknown[];
      writeChild(parent, key, mine);
      parent = mine;
    }
    const last = pathKey(op.at, op.at.length - 1);
    if ("set" in op) writeChild(parent, last, op.set, true);
    else writeChild(parent, last, grown(readChild(parent, last, op.at), op));
  }
  return root;
}

/** `cur` grown by an `append` or `push` op. */
function grown(cur: unknown, op: ValuePatchWireOp): unknown {
  if ("append" in op) {
    if (typeof cur !== "string" || typeof op.append !== "string")
      throw new Error(
        `applyValuePatch: append to a non-string at ${pathText(op.at)}`,
      );
    return cur + op.append;
  }
  if ("push" in op) {
    if (!Array.isArray(cur) || !Array.isArray(op.push))
      throw new Error(
        `applyValuePatch: push to a non-array at ${pathText(op.at)}`,
      );
    return [...(cur as unknown[]), ...op.push];
  }
  throw new Error(
    `applyValuePatch: a set at the root (${pathText(op.at)}) is a whole value, not a patch`,
  );
}

function pathKey(at: readonly unknown[], i: number): string | number {
  const key = at[i];
  if (typeof key !== "string" && typeof key !== "number")
    throw new Error(
      `applyValuePatch: a path step that is no key or index at ${pathText(at)}`,
    );
  return key;
}

function pathText(at: readonly unknown[]): string {
  return JSON.stringify(at);
}

function readChild(
  parent: JsonObject | unknown[],
  key: string | number,
  at: readonly unknown[],
): unknown {
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || key < 0 || key >= parent.length)
      throw new Error(`applyValuePatch: no element at ${pathText(at)}`);
    return parent[key];
  }
  if (
    typeof key !== "string" ||
    !Object.prototype.hasOwnProperty.call(parent, key) ||
    parent[key] === undefined
  )
    throw new Error(`applyValuePatch: no member at ${pathText(at)}`);
  return parent[key];
}

function writeChild(
  parent: JsonObject | unknown[],
  key: string | number,
  value: unknown,
  mayAdd = false,
): void {
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || key < 0 || key >= parent.length)
      throw new Error(`applyValuePatch: no element at index ${String(key)}`);
    parent[key] = value;
    return;
  }
  if (typeof key !== "string")
    throw new Error(`applyValuePatch: an index into an object (${key})`);
  if (!mayAdd && !Object.prototype.hasOwnProperty.call(parent, key))
    throw new Error(`applyValuePatch: no member "${key}"`);
  parent[key] = value;
}
