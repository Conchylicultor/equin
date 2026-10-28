import {
  inspect,
  isZodSchema,
  type Schema,
  type SchemaNode,
} from "@plugins/packages/plugins/zod-introspect/core";
import {
  checkMax,
  checkReason,
  LIST_BOUND_TAG,
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
 * Walk every array, record, map and set reachable from `schema` (read through
 * zod-introspect's {@link inspect}) — through objects
 * (and a schema catchall, itself a record), every wrapper (optional,
 * nullable, default, prefault, catch, readonly, nonoptional, promise; a
 * brand and a refinement are no wrapper at all), a pipe's in and out (a
 * transform's is the schema it transforms), unions and discriminated unions,
 * intersections, tuples (a `.rest()` one is a list) and `lazy` (recursion cut
 * by the walk's own stack) — and report each one's bound. `unknown` / `any`
 * are opaque, and so is an object that keeps unknown keys as they are
 * (`.passthrough()`, or a catchall of `unknown` / `any` — zod 4 spells the
 * one as the other): no schema says what they hold. REPORT mode: a bare list
 * is listed, never refused.
 *
 * A list is capped by a native `.max(n)` / `.length(n)` (an array),
 * `.max(n)` / `.size(n)` (a set), a finite key set (a record keyed by an enum
 * or literals), or a `{ max }` tag; whole by a `{ reason }` tag. A cap wins
 * over a reason: it is the one the parse enforces.
 *
 * THROWS on what is no declaration at all: a malformed tag (an empty reason,
 * a non-positive max), and a node that is not a zod schema — an unknown
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

class Walker {
  /** The nodes on the current path — a node met again below itself is a recursion, cut. */
  private readonly active = new Set<unknown>();
  /** Each fully-walked node's lists, relative to it: a schema shared by many fields is walked once. */
  private readonly memo = new Map<unknown, readonly Entry[]>();

  /** `path` is for error messages only (the memo is path-free). */
  visit(schema: unknown, path: string): Visit {
    if (!isZodSchema(schema)) {
      throw new Error(
        `listShapeOf: \`${formatPath(path)}\` is not a zod schema — the walk ` +
          `cannot tell what lists it holds.`,
      );
    }
    if (this.active.has(schema)) return { entries: [], cut: true };
    const memoized = this.memo.get(schema);
    if (memoized !== undefined) return { entries: memoized, cut: false };
    this.active.add(schema);
    const visit = this.walk(inspect(schema), path);
    this.active.delete(schema);
    if (!visit.cut) this.memo.set(schema, visit.entries);
    return visit;
  }

  private walk(node: SchemaNode, path: string): Visit {
    const out: Entry[] = [];
    let cut = false;
    const child = (schema: Schema, seg: string): void => {
      const v = this.visit(schema, path + seg);
      cut ||= v.cut;
      for (const e of v.entries) out.push({ rel: seg + e.rel, bound: e.bound });
    };
    const list = (bound: ListBoundTag | null): void => {
      out.push({ rel: "", bound });
    };
    switch (node.kind) {
      case "string":
      case "number":
      case "bigint":
      case "boolean":
      case "date":
      case "symbol":
      case "undefined":
      case "null":
      case "void":
      case "never":
      case "any":
      case "unknown":
      case "nan":
      case "file":
      case "function":
      case "template_literal":
      case "literal":
      case "enum":
      case "transform":
        break;
      case "optional":
      case "nullable":
      case "readonly":
      case "nonoptional":
      case "catch":
      case "promise":
      case "success":
      case "lazy":
      case "default":
      case "prefault":
        child(node.inner, "");
        break;
      case "array":
      case "set":
        list(nativeCap(node.max) ?? tagOf(node.schema, path));
        child(node.element, "[]");
        break;
      case "record": {
        // A loose record keeps every key its key schema refuses: a finite
        // key set does not bound it.
        const keys =
          node.mode === "loose" ? undefined : finiteKeyCount(node.key);
        const tag = tagOf(node.schema, path);
        list(
          tag !== null && "max" in tag
            ? tag
            : keys !== undefined
              ? { max: keys }
              : tag,
        );
        child(node.value, "{}");
        break;
      }
      case "map":
        list(nativeCap(node.max) ?? tagOf(node.schema, path));
        child(node.key, "{key}");
        child(node.value, "{}");
        break;
      case "tuple":
        node.items.forEach((item, i) => child(item, `[${i}]`));
        if (node.rest !== null) {
          // A `.rest()` tuple holds any number of trailing items: a list.
          list(tagOf(node.schema, path));
          child(node.rest, "[]");
        }
        break;
      case "object":
        for (const [k, v] of Object.entries(node.shape)) child(v, `.${k}`);
        if (typeof node.unknownKeys === "object") {
          // A schema catchall admits any number of extra keys: a record.
          list(tagOf(node.schema, path));
          child(node.unknownKeys.catchall, "{}");
        }
        break;
      case "pipe":
        child(node.in, "");
        child(node.out, "");
        break;
      case "intersection":
        child(node.left, "");
        child(node.right, "");
        break;
      case "union":
        for (const o of node.options) child(o, "");
        break;
      default: {
        const unknownNode: never = node;
        throw new Error(
          `listShapeOf: \`${formatPath(path)}\` is a ${(unknownNode as SchemaNode).kind}, a zod kind the walk ` +
            `does not know — teach it (packages/list-bound) rather than ` +
            `letting its lists pass unseen.`,
        );
      }
    }
    return { entries: out, cut };
  }
}

/** A native size cap (`.max(n)` / `.length(n)` / `.size(n)`, an array's, set's or map's), or null. */
function nativeCap(max: number | undefined): ListBoundTag | null {
  return max === undefined ? null : { max };
}

/** The marker tag on `schema`, checked — null when there is none. */
function tagOf(schema: Schema, path: string): ListBoundTag | null {
  const tag = LIST_BOUND_TAG.get(schema);
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
 * names (a native enum's numeric reverse mappings are no names), a literal's
 * values, a union of those. Undefined for an open key set.
 */
function finiteKeyCount(keyType: Schema): number | undefined {
  const node = inspect(keyType);
  if (node.kind === "enum") return Object.keys(node.entries).length;
  if (node.kind === "literal") return node.values.length;
  if (node.kind !== "union") return undefined;
  let n = 0;
  for (const o of node.options) {
    const c = finiteKeyCount(o);
    if (c === undefined) return undefined;
    n += c;
  }
  return n;
}

/** A path as reported: no leading dot, and the root named. */
function formatPath(path: string): string {
  const p = path.startsWith(".") ? path.slice(1) : path;
  return p === "" ? LIST_ROOT_PATH : p;
}
