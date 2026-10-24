import {
  checkMax,
  checkReason,
  LIST_BOUND_DEF_KEY,
  type ListBoundTag,
} from "./markers";

/**
 * One list a schema reaches, with its bound: capped at `max` items, or loaded
 * whole for `reason`. `path` names it from the schema's root: object keys
 * dotted, `[]` an array's (or a set's) items, `{}` a record's (or a map's)
 * values, `[i]` a tuple's i-th item — `rows[].segments` — and
 * {@link LIST_ROOT_PATH} the root itself.
 */
export type ListBound =
  | { readonly path: string; readonly max: number }
  | { readonly path: string; readonly reason: string };

/**
 * Every list a schema reaches: the bounded ones, and the paths of the BARE
 * ones (no cap, no reason). A bare list is what a declaration must not hold —
 * {@link listBoundsOf} refuses one; {@link listShapeOf} reports it.
 */
export interface ListShape {
  readonly bounds: readonly ListBound[];
  readonly bare: readonly string[];
}

/** The path of the schema's root itself (a root that is a list). */
export const LIST_ROOT_PATH = "(root)";

/** Thrown by {@link listBoundsOf}: the schema reaches a list with no bound. */
export class BareListError extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[], where?: string) {
    super(
      `${where ?? "listBoundsOf"}: ${paths.length === 1 ? "a list" : `${paths.length} lists`} ` +
        `with no bound — ${paths.map((p) => `\`${p}\``).join(", ")}. Declare each ` +
        `capped (cappedList / cappedRecord, or a native .max(n)) or whole ` +
        `(wholeList / wholeRecord, with the reason loading it entire is honest).`,
    );
    this.name = "BareListError";
    this.paths = paths;
  }
}

export interface ListWalkOptions {
  /**
   * The path the schema itself sits at, prefixed to every path reported — a
   * paged value's item schema is walked `at: "[]"` (an item of a page).
   */
  at?: string;
}

/**
 * Walk every `ZodArray`, `ZodRecord`, `ZodMap` and `ZodSet` reachable from
 * `schema` — through objects (and a non-`never` catchall, itself a record),
 * every wrapper (optional, nullable, default, catch, readonly, branded,
 * effects, a pipeline's in and out, promise), unions and discriminated unions,
 * intersections, tuples (a `.rest()` one is a list) and `lazy` (recursion cut
 * by the walk's own stack) — and report each one's bound. `unknown` / `any`
 * are opaque. REPORT mode: a bare list is listed, never refused.
 *
 * A list is capped by a native `.max(n)` / `.length(n)` (an array),
 * `.max(n)` / `.size(n)` (a set), a finite key set (a record keyed by an enum
 * or literals), or a `{ max }` tag; whole by a `{ reason }` tag. A cap wins
 * over a reason: it is the one the parse enforces.
 *
 * THROWS on what is no declaration at all: a malformed tag (an empty reason,
 * a non-positive max), and a node that is not a zod 3 schema — an unknown
 * kind would otherwise pass as having no lists.
 */
export function listShapeOf(
  schema: unknown,
  opts: ListWalkOptions = {},
): ListShape {
  const walker = new Walker();
  const entries = walker.visit(schema, opts.at ?? "").entries;
  const bounds: ListBound[] = [];
  const bare: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const path = formatPath((opts.at ?? "") + e.rel);
    const id = `${path}\0${JSON.stringify(e.bound)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (e.bound === null) bare.push(path);
    else
      bounds.push(
        "max" in e.bound
          ? { path, max: e.bound.max }
          : { path, reason: e.bound.reason },
      );
  }
  return { bounds, bare };
}

/**
 * {@link listShapeOf}, ENFORCING: every list `schema` reaches is bounded, or
 * a {@link BareListError} names each bare one. Returns the bounds.
 */
export function listBoundsOf(
  schema: unknown,
  opts: ListWalkOptions & { where?: string } = {},
): readonly ListBound[] {
  const shape = listShapeOf(schema, opts);
  if (shape.bare.length > 0) throw new BareListError(shape.bare, opts.where);
  return shape.bounds;
}

/** One list, its path relative to the node it was found under. */
interface Entry {
  rel: string;
  bound: ListBoundTag | null;
}

/** What visiting one node yields; `cut` when a recursion was cut below it (not memoizable). */
interface Visit {
  entries: readonly Entry[];
  cut: boolean;
}

/** The zod kinds that hold no schema (a leaf): nothing below them to walk. */
const LEAF_KINDS: ReadonlySet<string> = new Set([
  "ZodString",
  "ZodNumber",
  "ZodNaN",
  "ZodBigInt",
  "ZodBoolean",
  "ZodDate",
  "ZodSymbol",
  "ZodUndefined",
  "ZodNull",
  "ZodAny",
  "ZodUnknown",
  "ZodNever",
  "ZodVoid",
  "ZodLiteral",
  "ZodEnum",
  "ZodNativeEnum",
  "ZodFunction",
]);

/** The wrappers whose one inner schema is `_def.innerType`. */
const INNER_TYPE_KINDS: ReadonlySet<string> = new Set([
  "ZodOptional",
  "ZodNullable",
  "ZodDefault",
  "ZodCatch",
  "ZodReadonly",
]);

class Walker {
  /** The nodes on the current path — a node met again below itself is a recursion, cut. */
  private readonly active = new Set<unknown>();
  /** Each fully-walked node's lists, relative to it: a schema shared by many fields is walked once. */
  private readonly memo = new Map<unknown, readonly Entry[]>();

  /** `path` is for error messages only (the memo is path-free). */
  visit(node: unknown, path: string): Visit {
    const kind = zodKind(node);
    if (kind === undefined) {
      throw new Error(
        `listShapeOf: \`${formatPath(path)}\` is not a zod 3 schema — the walk ` +
          `cannot tell what lists it holds.`,
      );
    }
    if (this.active.has(node)) return { entries: [], cut: true };
    const memoized = this.memo.get(node);
    if (memoized !== undefined) return { entries: memoized, cut: false };
    this.active.add(node);
    const visit = this.walk(kind, node as { _def: Def }, path);
    this.active.delete(node);
    if (!visit.cut) this.memo.set(node, visit.entries);
    return visit;
  }

  private walk(kind: string, node: { _def: Def }, path: string): Visit {
    const def = node._def;
    const out: Entry[] = [];
    let cut = false;
    const child = (schema: unknown, seg: string): void => {
      const v = this.visit(schema, path + seg);
      cut ||= v.cut;
      for (const e of v.entries) out.push({ rel: seg + e.rel, bound: e.bound });
    };
    const list = (bound: ListBoundTag | null): void => {
      out.push({ rel: "", bound });
    };
    if (LEAF_KINDS.has(kind)) return { entries: out, cut };
    if (INNER_TYPE_KINDS.has(kind)) {
      child(def.innerType, "");
      return { entries: out, cut };
    }
    switch (kind) {
      case "ZodArray":
        list(
          nativeCap(def.exactLength) ??
            nativeCap(def.maxLength) ??
            tagOf(def, path),
        );
        child(def.type, "[]");
        break;
      case "ZodSet":
        list(nativeCap(def.maxSize) ?? tagOf(def, path));
        child(def.valueType, "[]");
        break;
      case "ZodRecord": {
        const keys = finiteKeyCount(def.keyType);
        const tag = tagOf(def, path);
        list(
          tag !== null && "max" in tag
            ? tag
            : keys !== undefined
              ? { max: keys }
              : tag,
        );
        child(def.valueType, "{}");
        break;
      }
      case "ZodMap":
        list(tagOf(def, path));
        child(def.keyType, "{key}");
        child(def.valueType, "{}");
        break;
      case "ZodTuple": {
        const items = def.items as readonly unknown[];
        items.forEach((item, i) => child(item, `[${i}]`));
        if (def.rest !== null && def.rest !== undefined) {
          // A `.rest()` tuple holds any number of trailing items: a list.
          list(tagOf(def, path));
          child(def.rest, "[]");
        }
        break;
      }
      case "ZodObject": {
        const shape = (def.shape as () => Record<string, unknown>)();
        for (const [k, v] of Object.entries(shape)) child(v, `.${k}`);
        if (zodKind(def.catchall) !== "ZodNever") {
          // A catchall admits any number of extra keys: a record.
          list(tagOf(def, path));
          child(def.catchall, "{}");
        }
        break;
      }
      case "ZodEffects":
        child(def.schema, "");
        break;
      case "ZodBranded":
      case "ZodPromise":
        child(def.type, "");
        break;
      case "ZodLazy":
        child((def.getter as () => unknown)(), "");
        break;
      case "ZodPipeline":
        child(def.in, "");
        child(def.out, "");
        break;
      case "ZodIntersection":
        child(def.left, "");
        child(def.right, "");
        break;
      case "ZodUnion":
      case "ZodDiscriminatedUnion":
        for (const o of def.options as readonly unknown[]) child(o, "");
        break;
      default:
        throw new Error(
          `listShapeOf: \`${formatPath(path)}\` is a ${kind}, a zod kind the walk ` +
            `does not know — teach it (packages/list-bound) rather than ` +
            `letting its lists pass unseen.`,
        );
    }
    return { entries: out, cut };
  }
}

type Def = Record<string, unknown>;

/** A schema's zod 3 kind (`_def.typeName`), or undefined for anything else. */
function zodKind(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null || !("_def" in node)) {
    return undefined;
  }
  const def: unknown = node._def;
  if (typeof def !== "object" || def === null || !("typeName" in def)) {
    return undefined;
  }
  return typeof def.typeName === "string" ? def.typeName : undefined;
}

/** A native size check's cap (`_def.maxLength` and its kin: `{ value }`), or null. */
function nativeCap(check: unknown): ListBoundTag | null {
  if (typeof check !== "object" || check === null || !("value" in check)) {
    return null;
  }
  return typeof check.value === "number" ? { max: check.value } : null;
}

/** The marker tag on `def`, checked — null when there is none. */
function tagOf(def: Def, path: string): ListBoundTag | null {
  const tag = def[LIST_BOUND_DEF_KEY];
  if (tag === undefined) return null;
  const where = `list bound at \`${formatPath(path)}\``;
  if (typeof tag === "object" && tag !== null) {
    const keys = Object.keys(tag);
    if (keys.length === 1 && keys[0] === "max") {
      return { max: checkMax(where, (tag as { max: unknown }).max) };
    }
    if (keys.length === 1 && keys[0] === "reason") {
      return {
        reason: checkReason(where, (tag as { reason: unknown }).reason),
      };
    }
  }
  throw new Error(
    `${where}: a malformed tag ${JSON.stringify(tag)} — \`{ max }\` or ` +
      `\`{ reason }\`, set by the list-bound markers.`,
  );
}

/**
 * How many keys a record's key schema admits, when that is finite: an enum's
 * options, a literal, a union of those. Undefined for an open key set.
 */
function finiteKeyCount(keyType: unknown): number | undefined {
  const kind = zodKind(keyType);
  if (kind === undefined) return undefined;
  const def = (keyType as { _def: Def })._def;
  switch (kind) {
    case "ZodEnum":
      return (def.values as readonly unknown[]).length;
    case "ZodNativeEnum": {
      const e = def.values as Record<string, unknown>;
      // A numeric enum maps each value back to its name: count names only.
      return Object.keys(e).filter((k) => typeof e[e[k] as string] !== "number")
        .length;
    }
    case "ZodLiteral":
      return 1;
    case "ZodUnion": {
      let n = 0;
      for (const o of def.options as readonly unknown[]) {
        const c = finiteKeyCount(o);
        if (c === undefined) return undefined;
        n += c;
      }
      return n;
    }
    default:
      return undefined;
  }
}

/** A path as reported: no leading dot, and the root named. */
function formatPath(path: string): string {
  const p = path.startsWith(".") ? path.slice(1) : path;
  return p === "" ? LIST_ROOT_PATH : p;
}
