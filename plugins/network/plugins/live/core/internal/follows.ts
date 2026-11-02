import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import type {
  LivePagedValue,
  LiveQueryValue,
  LiveValue,
  LiveValueOrigin,
} from "./live-value";

// `follows` — a served value that reads a few rows reads them through
// collection TUPLES (research/2026-10-24-global-live-narrowed-reads.md §1):
//
//   serveValue(attemptWork, {
//     source: "db",
//     follows: (follow) => ({
//       attempt: follow(attemptWorkspacesServed, ({ attemptId }) => ({ ids: [attemptId] })),
//       convIds: follow(attemptConversationIdsServed, ({ attemptId }) => ({ where: { attemptId } })),
//     }),
//     loader: (p, { followed }) => attemptWorkFrom(p, followed),
//   });
//
// A follow targets a SERVED collection (the handle `serveCollection` returns
// carries its followable read, `FOLLOW_SOURCE` — so the target is served on
// this host by construction), never a descriptor:
//
// - `{ ids }` — the collection's `:rows` point set (a lookup-only, window or
//   unscoped `all` collection);
// - `{ where }` — one scope of a scoped `all` set (`all: { by }`).
//
// Anything else — a window's page, `:groups`, `:count`, a value, an external
// collection, a scope that is not the set's `by` — has no overload. A tuple
// function may answer `null`: that subject reads nothing of the follow (a
// registry value reading only the collection its params name).
//
// A DEPENDENT follow reads a tuple computed from other followed rows — a link
// table's rows naming the rows of another collection:
//
//   follows: (follow) => {
//     const links = follow(linksServed, ({ ownerId }) => ({ where: { ownerId } }));
//     const files = follow.from({ links }, filesServed, (_s, { links }) => ({
//       ids: links.map((l) => l.fileId),
//     }));
//     return { links, files };
//   },
//
// `follow.from(deps, target, tupleOf)` names the follows it reads (made
// before it, so the follows form a DAG by construction); they are read
// first, and the tuple is computed from their rows. Its routes match what
// the follower tuple's LAST LOAD named (`noteLoaded`, resource-runtime's
// `RouteVia.loaded`): the loader's read notes every dependent tuple, and
// the runtime routes those routes past their match before a first load and
// while a load is in flight. The
// follower's hooks are handed `followed[name]`: the tuple's rows, read FRESH
// in the hook's own call through the collection's own read (its loader span,
// its drift guard), so the routes the host compiles from the collection's
// plan (query-resource's `followRead`) cover exactly what was read. This file
// is the host-agnostic half: the spelling, the read, the subject a wire
// tuple names; the reach plan is the Bun host's (`live/server`).

/** The key a served collection's followable read rides under. */
export const FOLLOW_SOURCE: unique symbol = Symbol("live.follow-source");

/** A `:rows` tuple: these ids. */
export interface FollowIds {
  readonly ids: readonly string[];
}

/** A scoped `all` tuple: the scope, exactly the set's `by` fields. */
export interface FollowWhere<B extends string> {
  readonly where: { readonly [K in B]: string };
}

/**
 * A served collection's followable read, put on its served handle by
 * `serveCollection` (`live/server`) — what `follow` reads and the host
 * compiles routes from.
 */
interface FollowSourceBase<Row, T> {
  /** The followed resource's key (`_debug`'s `follows`). */
  readonly collection: string;
  /**
   * The tuple's rows, read fresh through the collection's own loader (the
   * runtime's `loadResourceFresh`: its own loader span and drift guard,
   * never a joined flight).
   */
  read(tuple: T): Promise<readonly Row[]>;
  /**
   * The follow's routes for a follower tuple reading `tuple` (from its
   * params, or its last load) — query-resource's `FollowRead`, opaque here (core
   * holds no drizzle). Throws before a deferred collection is bound.
   */
  reach(name: string, tuple: FollowReachTuple<T>): unknown;
  /** The collection compiles at `bindDeferredResources`: a follower of it binds there too. */
  readonly deferred: boolean;
}

/**
 * Which tuple of a follow a follower tuple reads, for its routes: from its
 * params, or — a dependent follow — from what its last load noted
 * (`FollowLoaded`). `null`: none.
 */
export type FollowReachTuple<T> =
  | {
      readonly loaded: false;
      readonly of: (params: ResourceParams) => T | null;
    }
  | { readonly loaded: true; readonly of: (loaded: unknown) => T | null };

/** The followable read of a `:rows` point set. */
export type FollowIdsSource<Row> = FollowSourceBase<Row, FollowIds> & {
  readonly form: "ids";
};

/** The followable read of a scoped `all` set. */
export type FollowWhereSource<Row, B extends string> = FollowSourceBase<
  Row,
  FollowWhere<B>
> & { readonly form: "where" };

/** A served collection followed by `{ ids }`. */
export interface FollowIdsTarget<Row> {
  readonly [FOLLOW_SOURCE]: FollowIdsSource<Row>;
}

/** A served scoped `all` collection, followed by `{ where }`. */
export interface FollowWhereTarget<Row, B extends string> {
  readonly [FOLLOW_SOURCE]: FollowWhereSource<Row, B>;
}

// The marks of a `follow` result: a Follow is made by the builder alone, and
// its row type rides a phantom.
const FOLLOW: unique symbol = Symbol("live.follow");
declare const FOLLOW_ROW: unique symbol;

/** A tuple a follow reads, or `null`: this subject reads nothing of it. */
type FollowTuple = FollowIds | FollowWhere<string>;

/** One follow: a target and the tuple a subject reads of it (see the header). */
export interface Follow<Row> {
  readonly [FOLLOW]: {
    readonly source:
      FollowIdsSource<unknown> | FollowWhereSource<unknown, string>;
    /** The follows a dependent follow (`follow.from`) reads first; `null` for a plain one. */
    readonly deps: FollowMap | null;
    readonly tupleOf: (subject: never, rows: never) => FollowTuple | null;
  };
  readonly [FOLLOW_ROW]?: Row;
}

/** A value's follows, by name. */
export type FollowMap = Readonly<Record<string, Follow<unknown>>>;

/** The follows of a value declaring none (the default). */
export type NoFollows = Record<never, never>;

/** The rows each follow reads for one tuple, by name. */
export type Followed<F> = {
  readonly [K in keyof F]: F[K] extends Follow<infer Row>
    ? readonly Row[]
    : never;
};

/** Whether `F` names any follow (a value declaring none has `NoFollows`). */
export type HasFollows<F> = [keyof F] extends [never] ? false : true;

/**
 * The extra argument a follower's `loader` / `revalidate` / paged `meta` take:
 * `{ followed }` — none for a value with no follows.
 */
export type FollowArgs<F> =
  HasFollows<F> extends true ? [ctx: { readonly followed: Followed<F> }] : [];

/**
 * The `follow` a value's `follows` is handed: a target and the tuple each
 * subject (the params, or a typed-query / paged value's decoded question)
 * reads of it — `{ ids }` for a `:rows` point set, `{ where }` for a scoped
 * `all` set's scope.
 */
export interface FollowBuilder<S> {
  <Row>(
    target: FollowIdsTarget<Row>,
    tuple: (subject: S) => FollowIds | null,
  ): Follow<Row>;
  <Row, B extends string>(
    target: FollowWhereTarget<Row, B>,
    tuple: (subject: S) => FollowWhere<B> | null,
  ): Follow<Row>;
  /**
   * A DEPENDENT follow (see the header): its tuple is computed from the rows
   * of `deps` — follows made before it — read first.
   */
  from<D extends FollowMap, Row>(
    deps: D,
    target: FollowIdsTarget<Row>,
    tuple: (subject: S, rows: Followed<D>) => FollowIds | null,
  ): Follow<Row>;
  from<D extends FollowMap, Row, B extends string>(
    deps: D,
    target: FollowWhereTarget<Row, B>,
    tuple: (subject: S, rows: Followed<D>) => FollowWhere<B> | null,
  ): Follow<Row>;
}

/** The `follows` option over a subject `S`, producing `F`. */
export type FollowsFn<S, F> = (follow: FollowBuilder<S>) => F;

/** One compiled follow: its name, the collection read and the tuple a subject reads. */
export interface CompiledFollow {
  readonly name: string;
  readonly source:
    FollowIdsSource<unknown> | FollowWhereSource<unknown, string>;
  /** A dependent follow's dependencies, by name — `null` for a plain one. */
  readonly deps: readonly string[] | null;
  readonly tupleOf: (
    subject: unknown,
    rows: Readonly<Record<string, readonly unknown[]>>,
  ) => FollowTuple | null;
}

/**
 * What a load's read of the dependent follows named — each one's tuple by
 * name — handed to the runtime (`LoadRun.noteLoaded`) and back to the
 * follow routes' `usesOf` as `loaded`.
 */
export type FollowLoaded = Readonly<Record<string, FollowTuple | null>>;

/** A value's follows, compiled once per `follows` function (`followsOf`). */
export interface CompiledFollows {
  readonly list: readonly CompiledFollow[];
  /** Whether any follow is dependent (`follow.from`). */
  readonly dependent: boolean;
  /**
   * Every follow's rows for `subject`, by name: the plain ones in parallel,
   * each dependent one once its dependencies are read. `note` is handed
   * what the dependent follows named (`FollowLoaded`) — the loader's read
   * passes the runtime's `noteLoaded`.
   */
  read(
    subject: unknown,
    note?: (loaded: FollowLoaded) => void,
  ): Promise<Readonly<Record<string, readonly unknown[]>>>;
}

/** The one `follow` every `follows` is handed: it checks the target and wraps it. */
function follow(target: unknown, tupleOf: unknown): Follow<unknown> {
  return makeFollow(null, target, tupleOf);
}

/** `follow.from`: a dependent follow, reading `deps` first. */
follow.from = (
  deps: unknown,
  target: unknown,
  tupleOf: unknown,
): Follow<unknown> => {
  if (typeof deps !== "object" || deps === null) {
    throw new Error(
      "follow.from: the dependencies are a record of follows by name — `follow.from({ links }, target, (subject, { links }) => tuple)`.",
    );
  }
  return makeFollow(deps as FollowMap, target, tupleOf);
};

function makeFollow(
  deps: FollowMap | null,
  target: unknown,
  tupleOf: unknown,
): Follow<unknown> {
  const source = (target as Partial<FollowIdsTarget<unknown>> | null)?.[
    FOLLOW_SOURCE
  ];
  if (source === undefined) {
    // Unreachable from typed code (the builder's overloads).
    throw new Error(
      "follow: the target is no served collection's followable read — follow the handle `serveCollection` returned (a `:rows` set by `ids`, a scoped `all` set by `where`).",
    );
  }
  if (typeof tupleOf !== "function") {
    throw new Error(
      `follow("${source.collection}"): the tuple must be a function of the subject.`,
    );
  }
  return {
    [FOLLOW]: {
      source,
      deps,
      tupleOf: tupleOf as (subject: never, rows: never) => FollowTuple | null,
    },
  };
}

// One compile per `follows` function: the serving path and the host's reach
// compile both ask for it, and must hold the same follows.
const compiled = new WeakMap<object, CompiledFollows>();

/**
 * Compile a value's `follows` (once per function: `serveValue`'s compile and
 * the host's reach compile share it), or `null` when it declares none. A
 * follows answering no follow, or a non-follow under a name, throws.
 */
export function followsOf(
  key: string,
  follows: unknown,
): CompiledFollows | null {
  if (follows === undefined) return null;
  if (typeof follows !== "function") {
    throw new Error(
      `serveValue("${key}"): \`follows\` is a function \`(follow) => ({ name: follow(served, tupleOf) })\`.`,
    );
  }
  const known = compiled.get(follows);
  if (known !== undefined) return known;
  const map = (follows as (b: typeof follow) => unknown)(follow);
  if (typeof map !== "object" || map === null) {
    throw new Error(
      `serveValue("${key}"): \`follows\` answered ${JSON.stringify(map)}, not a record of follows by name.`,
    );
  }
  // Each follow's name, by identity: a dependent follow names its
  // dependencies by the objects `follow` made, which must be in the map.
  const nameOf = new Map<object, string>();
  for (const [name, f] of Object.entries(map)) {
    if (nameOf.has(f as object)) {
      throw new Error(
        `serveValue("${key}"): one follow is named both "${nameOf.get(f as object)}" and "${name}" — name each follow once.`,
      );
    }
    nameOf.set(f as object, name);
  }
  const list: CompiledFollow[] = Object.entries(map).map(([name, f]) => {
    const spec = (f as Partial<Follow<unknown>> | null)?.[FOLLOW];
    if (spec === undefined) {
      throw new Error(
        `serveValue("${key}"): the follow "${name}" was not made by \`follow(served, tupleOf)\`.`,
      );
    }
    const deps =
      spec.deps === null
        ? null
        : Object.entries(spec.deps).map(([alias, dep]) => {
            const depName = nameOf.get(dep as object);
            if (depName === undefined) {
              throw new Error(
                `serveValue("${key}"): the follow "${name}" reads "${alias}" (\`follow.from\`), which \`follows\` does not return — return every follow it reads.`,
              );
            }
            return [alias, depName] as const;
          });
    if (deps !== null && deps.length === 0) {
      throw new Error(
        `serveValue("${key}"): the follow "${name}" is \`follow.from({}, …)\` — a dependent follow reads at least one follow; else use \`follow(target, tupleOf)\`.`,
      );
    }
    const tupleOf = spec.tupleOf as (
      subject: unknown,
      rows: Readonly<Record<string, readonly unknown[]>>,
    ) => FollowTuple | null;
    return {
      name,
      source: spec.source,
      deps: deps === null ? null : deps.map(([, depName]) => depName),
      // A dependent tuple sees its dependencies under the aliases it named.
      tupleOf:
        deps === null
          ? tupleOf
          : (subject, rows) =>
              tupleOf(
                subject,
                Object.fromEntries(
                  deps.map(([alias, depName]) => [alias, rows[depName]!]),
                ),
              ),
    };
  });
  if (list.length === 0) {
    throw new Error(
      `serveValue("${key}"): \`follows\` names no follow — omit it.`,
    );
  }
  const dependent = list.some((f) => f.deps !== null);
  const out: CompiledFollows = {
    list,
    dependent,
    async read(subject, note) {
      const rows: Record<string, readonly unknown[]> = {};
      const loaded: Record<string, FollowTuple | null> = {};
      const reading = new Map<string, Promise<void>>();
      const byName = new Map(list.map((f) => [f.name, f]));
      const readOne = (f: CompiledFollow): Promise<void> => {
        const known = reading.get(f.name);
        if (known !== undefined) return known;
        const p = (async () => {
          if (f.deps !== null) {
            await Promise.all(f.deps.map((d) => readOne(byName.get(d)!)));
          }
          const answer = f.tupleOf(subject, rows);
          const tuple = answer === null ? null : checkedTuple(key, f, answer);
          if (f.deps !== null) loaded[f.name] = tuple;
          rows[f.name] = await readFollow(f, tuple);
        })();
        reading.set(f.name, p);
        return p;
      };
      await Promise.all(list.map(readOne));
      if (dependent) note?.(loaded);
      return Object.fromEntries(list.map((f) => [f.name, rows[f.name]!]));
    },
  };
  compiled.set(follows, out);
  return out;
}

/** One follow's rows for its checked tuple, read fresh — none for a `null` one. */
async function readFollow(
  f: CompiledFollow,
  tuple: FollowTuple | null,
): Promise<readonly unknown[]> {
  if (tuple === null) return [];
  // An empty id set names no row: nothing to read (`point.encode` refuses it).
  if ("ids" in tuple && tuple.ids.length === 0) return [];
  return (f.source.read as (t: typeof tuple) => Promise<readonly unknown[]>)(
    tuple,
  );
}

/** A follow's tuple, checked against its source's form (tsc's overloads, for a cast). */
export function checkedTuple(
  key: string,
  f: Pick<CompiledFollow, "name" | "source">,
  tuple: unknown,
): FollowIds | FollowWhere<string> {
  const form = f.source.form;
  const ok =
    typeof tuple === "object" &&
    tuple !== null &&
    (form === "ids"
      ? Array.isArray((tuple as Partial<FollowIds>).ids)
      : typeof (tuple as Partial<FollowWhere<string>>).where === "object" &&
        (tuple as Partial<FollowWhere<string>>).where !== null);
  if (!ok) {
    throw new Error(
      `serveValue("${key}"): the follow "${f.name}" of "${f.source.collection}" answered ${JSON.stringify(tuple)} — a ${form === "ids" ? "`:rows` set is followed by `{ ids }`" : "scoped `all` set is followed by `{ where }`"}.`,
    );
  }
  return tuple as FollowIds | FollowWhere<string>;
}

/**
 * How a value's WIRE tuple maps to the subject its follows read, per form —
 * what the host's reach compile hands each follow's `usesOf`: a plain value's
 * params, a typed-query value's decoded question, a paged value's question
 * (its pages' and its meta's tuples both carry `q`).
 */
export function followSubjectOf(
  value:
    | LiveValue<unknown, Record<string, string>, LiveValueOrigin>
    | LivePagedValue<unknown, unknown, unknown, unknown, LiveValueOrigin>,
): (params: ResourceParams) => unknown {
  const decl = value as {
    paged?: unknown;
    query?: LiveQueryValue<unknown, unknown, unknown, LiveValueOrigin>["query"];
  };
  if (decl.paged !== undefined) {
    const codec = (
      value as LivePagedValue<
        unknown,
        unknown,
        unknown,
        unknown,
        LiveValueOrigin
      >
    ).query;
    return (params) => codec.decodeQuery(params.q!);
  }
  const codec = decl.query;
  if (codec === undefined) return (params) => params;
  return (params) => codec.decode(params);
}

/**
 * The host's reach of every follow (`FollowSourceBase.reach`, opaque here),
 * each keyed off the follower's wire params through `subjectOf`.
 */
export function followReaches(
  key: string,
  follows: CompiledFollows,
  subjectOf: (params: ResourceParams) => unknown,
): unknown[] {
  return follows.list.map((f) =>
    // The source's tuple form is its own (`checkedTuple`); the reach is
    // opaque here, so its tuple type is erased.
    (
      f.source.reach as (
        name: string,
        tuple: FollowReachTuple<unknown>,
      ) => unknown
    )(
      f.name,
      f.deps === null
        ? {
            loaded: false,
            of: (params: ResourceParams) => {
              const tuple = f.tupleOf(subjectOf(params), {});
              return tuple === null ? null : checkedTuple(key, f, tuple);
            },
          }
        : {
            // Checked when the load read it (`read`).
            loaded: true,
            of: (loaded: unknown) =>
              (loaded as FollowLoaded | undefined)?.[f.name] ?? null,
          },
    ),
  );
}

/** Whether any follow reads a deferred collection (its follower binds at `bindDeferredResources`). */
export function followsDeferred(follows: CompiledFollows): boolean {
  return follows.list.some((f) => f.source.deferred);
}
