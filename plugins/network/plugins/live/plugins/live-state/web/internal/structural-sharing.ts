// Date-aware structural sharing for live-state's TanStack Query cache.
//
// WHY: TanStack Query's default `replaceEqualDeep` only recurses into PLAIN
// objects/arrays — `isPlainObject(new Date())` is `false`, so it treats every
// `Date` as opaque and returns the NEW value whenever the references differ.
// Live-state payloads intentionally carry `Date` fields (the resource schemas
// `z.coerce.date()` timestamps so consumers can rely on real Dates), so a fresh
// Date instance lands in the payload on EVERY push. With the default algorithm
// that one new reference bubbles all the way up and makes the whole payload a
// new reference each push — defeating the documented slice-selector dedup
// (`select` + `replaceEqualDeep`) and re-rendering every consumer ~N/s even when
// nothing the UI shows actually changed.
//
// This is a faithful reimplementation of TanStack Query v5's `replaceEqualDeep`
// (deep structural sharing: for plain arrays/objects, recurse and preserve the
// PREVIOUS reference when every element/key is referentially preserved;
// otherwise return the new value) with TWO added branches: two equal `Date`
// instances collapse to the previous reference, and an array element that is
// NOT positionally equal but is, by reference, an element the previous array
// held at another index is kept as that object (a keyed `order` delta moves
// rows by reusing their cached objects; the positional default would re-mint
// each moved row as a fresh copy, re-rendering every memoized row between the
// old and new positions). It is therefore strictly STRONGER sharing than the
// default (it only ever preserves a reference when the values are deeply
// equal — including Date millis — or the reference is already one the previous
// value held, and still prefers the positional match first) and NEVER weaker —
// safe for every resource, with or without a `select`.
//
// Kept dependency-free on purpose: we do not import @tanstack/query-core
// internals (`replaceEqualDeep` / `isPlainObject` are not part of its public
// API). The helpers below mirror the originals exactly.

const hasOwn = Object.prototype.hasOwnProperty;

function hasObjectPrototype(o: unknown): boolean {
  return Object.prototype.toString.call(o) === "[object Object]";
}

// Mirrors TanStack Query's `isPlainArray`: a real array whose only own
// enumerable keys are its indices (no extra string keys hung off it).
function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length === Object.keys(value).length;
}

// Mirrors TanStack Query's `isPlainObject` (copied from is-plain-object):
// excludes class instances like Date/Map/Set, so they are never recursed into.
function isPlainObject(o: unknown): o is Record<PropertyKey, unknown> {
  if (!hasObjectPrototype(o)) {
    return false;
  }

  // If has no constructor
  const ctor = (o as { constructor?: unknown }).constructor;
  if (ctor === undefined) {
    return true;
  }

  // If has modified prototype
  const prot = (ctor as { prototype?: unknown }).prototype;
  if (!hasObjectPrototype(prot)) {
    return false;
  }

  // If constructor does not have an Object-specific method
  if (!hasOwn.call(prot, "isPrototypeOf")) {
    return false;
  }

  // Handles Objects created by Object.create(<arbitrary prototype>)
  if (Object.getPrototypeOf(o) !== Object.prototype) {
    return false;
  }

  // Most likely a plain Object
  return true;
}

function replaceEqualDeepImpl(a: unknown, b: unknown, depth: number): unknown {
  if (a === b) {
    return a;
  }

  // The one added branch vs. the original: collapse two equal Dates to the
  // previous reference (default RQ returns `b` here because a Date is neither a
  // plain object nor a plain array).
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime() ? a : b;
  }

  if (depth > 500) return b;

  const array = isPlainArray(a) && isPlainArray(b);

  if (!array && !(isPlainObject(a) && isPlainObject(b))) return b;

  const aObj = a as Record<PropertyKey, unknown>;
  const bObj = b as Record<PropertyKey, unknown>;
  const aItems = array ? (a as unknown[]) : Object.keys(aObj);
  const aSize = aItems.length;
  const bItems = array ? (b as unknown[]) : Object.keys(bObj);
  const bSize = bItems.length;
  const copy: Record<PropertyKey, unknown> | unknown[] = array
    ? new Array(bSize)
    : {};

  let equalItems = 0;
  // The second added branch (arrays only): the previous array's elements, by
  // reference — built on the first element that is not positionally equal.
  let prevMembers: Set<unknown> | undefined;

  for (let i = 0; i < bSize; i++) {
    const key = (array ? i : bItems[i]) as PropertyKey;
    const aItem = aObj[key];
    const bItem = bObj[key];

    if (aItem === bItem) {
      (copy as Record<PropertyKey, unknown>)[key] = aItem;
      if (array ? i < aSize : hasOwn.call(aObj, key)) equalItems++;
      continue;
    }

    if (
      aItem === null ||
      bItem === null ||
      typeof aItem !== "object" ||
      typeof bItem !== "object"
    ) {
      (copy as Record<PropertyKey, unknown>)[key] = bItem;
      continue;
    }

    const v = replaceEqualDeepImpl(aItem, bItem, depth + 1);
    if (v === aItem) {
      (copy as Record<PropertyKey, unknown>)[key] = aItem;
      equalItems++;
      continue;
    }
    // An element the previous array already held, at ANOTHER index (a row a
    // keyed `order` delta moved — the merge reuses the cached object): keep
    // that object rather than re-minting a copy of it merged against whatever
    // sat at this index before. Still a change to the array (not counted).
    if (array) {
      prevMembers ??= new Set(a as unknown[]);
      if (prevMembers.has(bItem)) {
        (copy as Record<PropertyKey, unknown>)[key] = bItem;
        continue;
      }
    }
    (copy as Record<PropertyKey, unknown>)[key] = v;
  }

  return aSize === bSize && equalItems === aSize ? a : copy;
}

/**
 * Drop-in replacement for TanStack Query's `structuralSharing` option. Matches
 * the v5 `structuralSharing` signature `(oldData, newData) => resolvedData` and
 * the default `replaceEqualDeep` semantics exactly, except equal `Date`
 * instances preserve the previous reference (see file-level comment for WHY).
 */
export function dateAwareReplaceEqualDeep(
  oldData: unknown | undefined,
  newData: unknown,
): unknown {
  return replaceEqualDeepImpl(oldData, newData, 0);
}
