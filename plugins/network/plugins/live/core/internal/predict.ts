import {
  brandEndpointEffect,
  endpointEffectPayload,
  type EffectOn,
  type EffectRequest,
  type EndpointEffect,
} from "@plugins/infra/plugins/endpoints/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type { EntityExposure } from "@plugins/infra/plugins/entity-extensions/core";
import type { FieldsRecord, InferFieldsObject } from "@plugins/fields/core";
import {
  canonicalizeFilter,
  type Filter,
  type FilterDomainId,
  type Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import { fieldDomain, schemaDomain } from "./field-domain";
import { LIVE_COLUMNS_KEY } from "./live-columns";
import type { LiveRowsCollection } from "./live-collection";
import type { LiveValue, LiveValueOrigin } from "./live-value";

// The predict builders: what a WRITE endpoint does to live data, declared on
// the endpoint (`defineEndpoint({ …, effect })`) — design in
// research/2026-10-27-global-predicted-endpoint-effects.md §1, its gaps closed
// in research/2026-10-28-global-endpoint-prediction-decision.md §3.
//
// An effect targets an ENTITY's rows (by id, or by a filter over the rows a
// reader holds) or a VALUE's tuple, never a collection of an entity: the
// overlay that applies it is keyed by SUBJECT (`predictSubject`) and row id,
// and by `(value key, params)`, so every collection whose rows are that
// entity (`liveCollection({ from })`) shows the prediction — collections
// added later included — with no edit to the effect. Rows no entity ref
// names (an extension shape's side table, a collection declared by its own
// fields) are targeted through their one collection declared `from: null`,
// whose reads alone show it.
//
// An effect predicts only what the REQUEST decides. A field the server
// derives (a rollup, a status another table drives) or decides (a
// precondition, a minted id) arrives by push, never predicted.
//
// CONFIRMATION. A target that declares compared fields (`patchRow`'s `set`,
// `upsertRow`'s `set`) is confirmed by a server row holding them, or a
// removal by the row's absence. Every other target — a reducer (`applyRows`),
// an upsert with no `set`, a filter-targeted patch, a value — has nothing to
// compare, so it is confirmed CAUSALLY: once the write is acked and the
// tuple's own frames have seen the commit the ack names (an `ackTx` of it, or
// a full frame's watermark past it — `infra/endpoints`' commit capture).
//
// The value a builder returns is endpoints' opaque `EndpointEffect` (the
// endpoints plugin sits below this one); its payload is a `LiveEffect`, read
// back by `readLiveEffect` alone.

/**
 * What a row builder targets: an ENTITY (every collection `from` it shows the
 * prediction), or — for rows no entity ref names (an extension shape's side
 * table, a collection declared by its own fields) — one collection declared
 * `from: null`, whose reads alone show it.
 */
export type PredictTarget =
  | EntityRef<string, FieldsRecord, string>
  // biome-ignore lint/suspicious/noExplicitAny: a collection's row type is invariant — erased here, recovered by `TargetRow`.
  | (LiveRowsCollection<any> & { readonly from: null });

/**
 * What a patch or a reducer may also target: the fields an extension EXPOSES
 * on an entity (`shape.exposure` — `playCount` on songs). They ride the
 * entity's rows under `$columns[<slice>]`, so the entity's own fields cannot
 * type them (the entity names none of its extensions): the exposure itself
 * is the target, its subject the parent entity's, and its builders
 * (`patchRow`, `applyRows`) read and write that slice of every row a read
 * holds — a row without it (a collection reaching no such exposure) is left
 * as it is. Never removed, upserted or filtered: the side row is not the
 * entity's row.
 */
export type PredictPatchTarget =
  | PredictTarget
  // biome-ignore lint/suspicious/noExplicitAny: an exposure's slice type is invariant — erased here, recovered by `TargetRow`.
  | EntityExposure<any>;

/**
 * The row a target's patches are checked against: the entity's fields, the
 * collection's row, or an exposure's slice.
 */
export type TargetRow<T> =
  T extends EntityExposure<infer R>
    ? R
    : T extends EntityRef<string, infer F, string>
      ? InferFieldsObject<F>
      : T extends LiveRowsCollection<infer R>
        ? R
        : never;

function exposureOf(t: PredictPatchTarget): EntityExposure | null {
  return (t as { kind?: unknown }).kind === "exposure"
    ? (t as EntityExposure)
    : null;
}

/** The subject a patch target names — an exposure's is its parent entity's. */
function patchSubject(target: PredictPatchTarget): string {
  const exposure = exposureOf(target);
  return exposure === null
    ? predictSubject(target as PredictTarget)
    : exposure.parent.name;
}

/**
 * How a builder reaches what it patches in a row: the row itself, or — for an
 * exposure — its `$columns[<slice>]` (`undefined`: the row carries none).
 */
interface RowLens {
  read(row: AnyRow): AnyRow | undefined;
  write(row: AnyRow, part: AnyRow): AnyRow;
}

const WHOLE_ROW: RowLens = { read: (row) => row, write: (_row, part) => part };

function lensOf(target: PredictPatchTarget): RowLens {
  const exposure = exposureOf(target);
  if (exposure === null) return WHOLE_ROW;
  const { slice } = exposure;
  return {
    read: (row) => {
      const columns = row[LIVE_COLUMNS_KEY] as
        Readonly<Record<string, AnyRow | undefined>> | undefined;
      return columns?.[slice];
    },
    write: (row, part) => ({
      ...row,
      [LIVE_COLUMNS_KEY]: {
        ...(row[LIVE_COLUMNS_KEY] as Record<string, unknown>),
        [slice]: part,
      },
    }),
  };
}

/**
 * The overlay's key for what a target names — the SUBJECT every op and every
 * read are matched on: an entity's name, `collection:<key>` for a `from: null`
 * collection, `value:<key>` for a value (an entity name holds no `:`).
 */
export function predictSubject(target: PredictTarget): string {
  if ((target as { kind?: unknown }).kind === "entity") {
    return (target as EntityRef).name;
  }
  const c = target as LiveRowsCollection<unknown>;
  if (c.from !== null) {
    throw new Error(
      `predict: collection ${c.key} is \`from\` entity ${c.from.name} — target the entity, so every collection of it shows the prediction.`,
    );
  }
  return `collection:${c.key}`;
}

/** The subject a live read of `collection` matches ops on (see {@link predictSubject}). */
export function readSubject(collection: {
  readonly key: string;
  readonly from: EntityRef | null;
}): string {
  return collection.from?.name ?? `collection:${collection.key}`;
}

/** The subject of a value's tuples (see {@link predictSubject}). */
export function valueSubject(key: string): string {
  return `value:${key}`;
}

/** What a {@link patchRow} writes onto the row. */
export interface RowPatch<Row> {
  /**
   * The fields the request decides: shown at once AND compared — the server
   * has confirmed the write once a row it sends holds these values.
   */
  readonly set: Partial<Row>;
  /**
   * Fields shown at once but never compared (a timestamp from the client's
   * clock: the server's will differ).
   */
  readonly approx?: Partial<Row>;
}

/** Per-effect options. */
export interface PredictOptions<P = unknown, B = unknown> {
  /**
   * How long the server has to confirm the prediction before the write is
   * reported unconfirmed (the overlay's deadline). Absent: the overlay's
   * default.
   */
  readonly confirmWithinMs?: number;
  /**
   * The send lane this part's write departs on, by name — for writes whose
   * order matters per PARENT (every fader of one song) rather than per row.
   * Absent: one lane per target row (every row the part names; one for the
   * entity, for a filter-targeted part; the tuple's, for a value).
   */
  readonly lane?: (req: EffectRequest<P, B>) => string;
}

/** {@link upsertRow}'s options. */
export interface UpsertOptions<Row, P, B> extends PredictOptions<P, B> {
  /**
   * The fields the request decides, compared like `patchRow`'s `set`: the
   * server has confirmed the upsert once a row it sends holds them. Absent:
   * confirmed by the write's commit.
   */
  readonly set?: (req: EffectRequest<P, B>, id: string) => Partial<Row>;
}

/** A row as the overlay handles it — any collection's, untyped. */
type AnyRow = Readonly<Record<string, unknown>>;

/**
 * One target of a resolved effect — the prediction for one or several rows
 * of one entity, or one value tuple, its request already fixed. Pure data
 * plus pure functions: the overlay asks it for the predicted row (or value)
 * and whether a server row confirms it, and nothing else.
 */
export type ResolvedLiveTarget =
  | {
      /** A row patched in place, removed, or upserted. */
      readonly kind: "row";
      /** What it targets ({@link predictSubject}) — the overlay's key, with the id. */
      readonly subject: string;
      readonly id: string;
      /**
       * The compared fields, or `null` (a removal, or an upsert confirmed by
       * commit). The overlay reads them to decide a membership exit's
       * confirmation.
       */
      readonly set: Readonly<Record<string, unknown>> | null;
      /** A removal: the row leaves every read. */
      readonly removes: boolean;
      /**
       * An upsert: an absent row is predicted to EXIST — a read that admits
       * it (a by-id read of its id, an `all` set it belongs to: its scope,
       * and its `membership` when declared) gains it. Never a window: an
       * entrant's row key is the server's.
       */
      readonly enters: boolean;
      /**
       * The predicted row from the server's (`undefined`: not held). A patch
       * of a row not held predicts nothing for it (`undefined` stays).
       */
      readonly apply: (row: AnyRow | undefined) => AnyRow | undefined;
      /**
       * Whether this server row (or its absence) already shows the write —
       * `null`: nothing to compare, confirmed by the write's commit.
       */
      readonly confirmedBy: ((row: AnyRow | undefined) => boolean) | null;
    }
  | {
      /**
       * A free-form reducer over a set of rows (`applyRows`). It declares no
       * compared fields: confirmed by the write's commit.
       */
      readonly kind: "rows";
      readonly subject: string;
      readonly ids: readonly string[];
      /** The predicted rows from the server's rows of `ids` that are held. */
      readonly apply: (rows: readonly AnyRow[]) => readonly AnyRow[];
    }
  | {
      /**
       * Every HELD row of the entity matching a filter (`patchWhere` /
       * `removeWhere`): confirmed by the write's commit.
       */
      readonly kind: "where";
      readonly subject: string;
      /** Canonical, over the entity's filterable fields. */
      readonly filter: Filter;
      readonly filterable: Filterable;
      /** The predicted row from a matching server row (`undefined`: removed). */
      readonly apply: (row: AnyRow) => AnyRow | undefined;
    }
  | {
      /** One tuple of a live value (`patchValue`): confirmed by the write's commit. */
      readonly kind: "value";
      /** {@link valueSubject} of `key`. */
      readonly subject: string;
      readonly key: string;
      /** The tuple's canonical params (what `useLive(value, params)` subscribes). */
      readonly params: Readonly<Record<string, string>>;
      /** The predicted value from the server's. */
      readonly apply: (value: unknown) => unknown;
    };

/**
 * A send lane a resolved effect names, as data — the browser derives the
 * lane's key from it (`network/live/web`'s send lanes).
 */
export type LiveLane =
  /** One target row's (its subject and id). */
  | { readonly kind: "row"; readonly subject: string; readonly id: string }
  /** A whole subject's (a filter-targeted part). */
  | { readonly kind: "subject"; readonly subject: string }
  /** One value tuple's — the one `useOptimisticResource` writes on too. */
  | {
      readonly kind: "value";
      readonly key: string;
      readonly params: Readonly<Record<string, string>>;
    }
  /** A named one (`PredictOptions.lane`). */
  | { readonly kind: "named"; readonly name: string };

/** An effect resolved against one request. */
export interface ResolvedLiveEffect {
  readonly targets: readonly ResolvedLiveTarget[];
  /**
   * Every lane its write departs on — each target's, or the part's named one
   * — deduplicated, in first-named order (the writer enters them all).
   */
  readonly lanes: readonly LiveLane[];
  /** The tightest `confirmWithinMs` any resolved part declared, or absent. */
  readonly confirmWithinMs?: number;
}

/** The payload an `EndpointEffect` built here carries (see {@link readLiveEffect}). */
export interface LiveEffect {
  /** Every part, in declaration order; `effects(...)` flattens. */
  readonly parts: readonly LiveEffectPart[];
  /**
   * Resolve against a request: what each target predicts, the request
   * fixed (the overlay calls it once, at dispatch).
   */
  readonly resolve: (
    req: EffectRequest<unknown, unknown>,
  ) => ResolvedLiveEffect;
}

/** One builder call, as data — the vocabulary's closed set of kinds. */
export type LiveEffectPart =
  | {
      readonly kind:
        "patch" | "remove" | "rows" | "upsert" | "patch-where" | "remove-where";
      readonly subject: string;
      readonly confirmWithinMs?: number;
    }
  | {
      readonly kind: "value";
      readonly key: string;
      readonly confirmWithinMs?: number;
    }
  | {
      /** `choose`: one branch per request, each its own parts. */
      readonly kind: "choose";
      readonly branches: Readonly<Record<string, readonly LiveEffectPart[]>>;
    };

/** Marks a payload as minted here, so a foreign one fails `readLiveEffect` loudly. */
const LIVE_EFFECT = Symbol("live-effect");

type AnyReq = EffectRequest<unknown, unknown>;

/** What one part resolves to against a request. */
interface ResolvedPart {
  readonly targets: readonly ResolvedLiveTarget[];
  readonly lanes: readonly LiveLane[];
  readonly confirmWithinMs?: number;
}

/** One part as minted: its data, and how it resolves against a request. */
interface Part {
  readonly part: LiveEffectPart;
  readonly resolve: (req: AnyReq) => ResolvedPart;
}

interface Minted extends LiveEffect {
  /** The parts with their resolvers — what `effects(...)` / `choose` compose. */
  readonly [LIVE_EFFECT]: readonly Part[];
}

function resolveParts(parts: readonly Part[], req: AnyReq): ResolvedPart {
  const targets: ResolvedLiveTarget[] = [];
  const lanes: LiveLane[] = [];
  const seen = new Set<string>();
  let confirmWithinMs: number | undefined;
  for (const p of parts) {
    const r = p.resolve(req);
    targets.push(...r.targets);
    for (const lane of r.lanes) {
      const id = laneIdentity(lane);
      if (seen.has(id)) continue;
      seen.add(id);
      lanes.push(lane);
    }
    if (r.confirmWithinMs !== undefined) {
      confirmWithinMs =
        confirmWithinMs === undefined
          ? r.confirmWithinMs
          : Math.min(confirmWithinMs, r.confirmWithinMs);
    }
  }
  return {
    targets: Object.freeze(targets),
    lanes: Object.freeze(lanes),
    ...(confirmWithinMs === undefined ? {} : { confirmWithinMs }),
  };
}

/** A lane's identity, for deduplication (the browser derives the real key). */
function laneIdentity(lane: LiveLane): string {
  switch (lane.kind) {
    case "row":
      return JSON.stringify(["row", lane.subject, lane.id]);
    case "subject":
      return JSON.stringify(["subject", lane.subject]);
    case "value":
      return JSON.stringify([
        "value",
        lane.key,
        Object.keys(lane.params)
          .sort()
          .map((k) => [k, lane.params[k]]),
      ]);
    case "named":
      return JSON.stringify(["named", lane.name]);
  }
}

function minted<P, B>(parts: readonly Part[]): EndpointEffect<P, B> {
  const frozen = Object.freeze([...parts]);
  const payload: Minted = Object.freeze({
    [LIVE_EFFECT]: frozen,
    parts: Object.freeze(frozen.map((p) => p.part)),
    resolve: (req: AnyReq): ResolvedLiveEffect =>
      Object.freeze(resolveParts(frozen, req)),
  });
  return brandEndpointEffect<P, B>(payload);
}

/**
 * One builder call as a part: its data, and its resolver — whose targets'
 * own lanes are replaced by the named one when the part declares `lane`.
 */
function part<P, B>(
  data: LiveEffectPart,
  opts: PredictOptions<P, B> | undefined,
  targetsOf: (req: EffectRequest<P, B>) => readonly ResolvedLiveTarget[],
): Part {
  const confirmWithinMs = opts?.confirmWithinMs;
  const lane = opts?.lane;
  return {
    part: data,
    resolve: (req) => {
      const r = req as EffectRequest<P, B>;
      const targets = Object.freeze(targetsOf(r));
      const lanes: readonly LiveLane[] =
        lane === undefined
          ? targets.flatMap(lanesOf)
          : [{ kind: "named", name: checkLane(data, lane(r)) }];
      return {
        targets,
        lanes,
        ...(confirmWithinMs === undefined ? {} : { confirmWithinMs }),
      };
    },
  };
}

function lanesOf(t: ResolvedLiveTarget): readonly LiveLane[] {
  switch (t.kind) {
    case "row":
      return [{ kind: "row", subject: t.subject, id: t.id }];
    case "rows":
      return t.ids.map((id) => ({ kind: "row", subject: t.subject, id }));
    case "where":
      return [{ kind: "subject", subject: t.subject }];
    case "value":
      return [{ kind: "value", key: t.key, params: t.params }];
  }
}

function checkLane(data: LiveEffectPart, name: unknown): string {
  if (typeof name !== "string" || name === "") {
    throw new Error(
      `predict ${data.kind}: the lane is ${JSON.stringify(name)} — a named lane is a non-empty string.`,
    );
  }
  return name;
}

function checkBudget(where: string, opts: PredictOptions | undefined): void {
  const ms = opts?.confirmWithinMs;
  if (ms !== undefined && !(Number.isFinite(ms) && ms > 0)) {
    throw new Error(
      `${where}: confirmWithinMs ${String(ms)} — a deadline is a positive number of ms.`,
    );
  }
}

function checkId(where: string, id: unknown): string {
  if (typeof id !== "string" || id === "") {
    throw new Error(
      `${where}: the id is ${JSON.stringify(id)} — a row is predicted by a non-empty string id.`,
    );
  }
  return id;
}

/**
 * Two field values agree as the wire carries them: a `Date` as its ISO
 * text, objects structurally (key order ignored).
 */
function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x === undefined) return null;
    if (x === null || typeof x !== "object" || Array.isArray(x)) return x;
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  });
}

/** Whether a server row holds every compared field. */
function holds(set: Readonly<Record<string, unknown>>) {
  return (row: AnyRow | undefined): boolean =>
    row !== undefined &&
    Object.entries(set).every(([k, v]) => sameValue(row[k], v));
}

function freezeData(
  kind: Exclude<LiveEffectPart["kind"], "choose" | "value">,
  subject: string,
  opts: PredictOptions<never, never> | undefined,
): LiveEffectPart {
  return Object.freeze({
    kind,
    subject,
    ...(opts?.confirmWithinMs === undefined
      ? {}
      : { confirmWithinMs: opts.confirmWithinMs }),
  });
}

/**
 * Every builder takes `on` first — the typed request `defineEndpoint` hands
 * its `effect` callback (endpoints' `EffectOn`) — so its request callbacks are
 * typed by the route with no annotation (a bare nested builder call would be
 * checked before the route is inferred, and get `params: unknown`).
 *
 * Patch one row of `target` — an entity, or a collection declared `from:
 * null` ({@link PredictTarget}): `idOf(req)` names it, `patchOf(req)` says
 * what the write sets (`set`, compared for confirmation) and what is only
 * shown (`approx`). `req` is the endpoint's request — `params` typed by its
 * route, `body` by its body schema — and the patch's keys and values are
 * checked against the target's row (`TargetRow`: the entity's fields, or the
 * collection's row).
 *
 * ```ts
 * effect: (on) =>
 *   patchRow(on, conversationsEntityRef, ({ params }) => params.id, () => ({
 *     set: { status: "done", workingOn: null },
 *     approx: { endedAt: new Date() },
 *   })),
 * ```
 *
 * A patch of a row the reader does not hold predicts nothing for it: an
 * entrant is the server's to send (its row key and counts are server-minted).
 */
export function patchRow<T extends PredictPatchTarget, P, B>(
  _on: EffectOn<P, B>,
  target: T,
  idOf: (req: EffectRequest<P, B>) => string,
  // `NoInfer`: the patch is typed by `target`, never a source of `T` — a
  // zero-argument `() => ({ set: { status: "done" } })` is not deferred like
  // a callback, so without it its literal would be widened mid-inference.
  patchOf: NoInfer<(req: EffectRequest<P, B>) => RowPatch<TargetRow<T>>>,
  opts?: PredictOptions<P, B>,
): EndpointEffect<P, B> {
  const subject = patchSubject(target);
  const where = `patchRow(${subject})`;
  checkBudget(where, opts as PredictOptions);
  const lens = lensOf(target);
  const exposed = lens !== WHOLE_ROW;
  return minted<P, B>([
    part(freezeData("patch", subject, opts as never), opts, (r) => {
      const id = checkId(where, idOf(r));
      const { set, approx } = patchOf(r) as {
        set: Record<string, unknown>;
        approx?: Record<string, unknown>;
      };
      const fixedSet = Object.freeze({ ...set });
      const shown = Object.freeze({ ...set, ...approx });
      const compare = holds(fixedSet);
      return [
        Object.freeze({
          kind: "row" as const,
          subject,
          id,
          // An exposure's fields are not the row's own: the overlay cannot
          // fill them in, so its comparison reads the slice itself.
          set: exposed ? null : fixedSet,
          removes: false,
          enters: false,
          apply: (row: AnyRow | undefined) => {
            if (row === undefined) return undefined;
            const part = lens.read(row);
            return part === undefined
              ? row
              : lens.write(row, { ...part, ...shown });
          },
          confirmedBy: exposed
            ? (row: AnyRow | undefined) => {
                if (row === undefined) return false;
                // A row carrying no such slice cannot disagree.
                const part = lens.read(row);
                return part === undefined || compare(part);
              }
            : compare,
        }),
      ];
    }),
  ]);
}

/** Remove one row of `target` (`idOf(req)`): it leaves every read of it at once. */
export function removeRow<P, B>(
  _on: EffectOn<P, B>,
  target: PredictTarget,
  idOf: (req: EffectRequest<P, B>) => string,
  opts?: PredictOptions<P, B>,
): EndpointEffect<P, B> {
  const subject = predictSubject(target);
  const where = `removeRow(${subject})`;
  checkBudget(where, opts as PredictOptions);
  return minted<P, B>([
    part(freezeData("remove", subject, opts as never), opts, (r) => {
      const id = checkId(where, idOf(r));
      return [
        Object.freeze({
          kind: "row" as const,
          subject,
          id,
          set: null,
          removes: true,
          enters: false,
          apply: () => undefined,
          confirmedBy: (row: AnyRow | undefined) => row === undefined,
        }),
      ];
    }),
  ]);
}

/**
 * Upsert one row of `target` that may be absent: `idOf(req)` names it,
 * `upsert(row, req)` returns the whole predicted row from the server's —
 * `undefined` when the reader holds none (it does not exist, or this read
 * does not hold it).
 *
 * ```ts
 * effect: (on) =>
 *   upsertRow(on, transposeEntityRef, ({ params }) => params.songId,
 *     (row, { params, body }) => ({ ...(row ?? { songId: params.songId }), semitones: body.semitones }),
 *     { set: ({ body }) => ({ semitones: body.semitones }) }),
 * ```
 *
 * An absent row ENTERS a read that admits it: a by-id read of its id
 * (`useLiveRow`, `{ ids }`) turns `found: false` into `found: true`, and an
 * `all` set gains it (in its `orderBy` place) when it belongs there — every
 * row of the collection does, within its `by` scope, when it declares no
 * `membership`; one matching its `membership` does, when it declares one. A
 * window never gains an entrant — its row key and counts are the server's. A
 * read whose rows carry a field the predicted row lacks (a computed one) is
 * not entered either: the server's frame brings it.
 *
 * With `set`, confirmed like `patchRow` (a server row holding those fields);
 * without, by the write's commit.
 */
export function upsertRow<T extends PredictTarget, P, B>(
  _on: EffectOn<P, B>,
  target: T,
  idOf: (req: EffectRequest<P, B>) => string,
  upsert: NoInfer<
    (row: TargetRow<T> | undefined, req: EffectRequest<P, B>) => TargetRow<T>
  >,
  opts?: NoInfer<UpsertOptions<TargetRow<T>, P, B>>,
): EndpointEffect<P, B> {
  return upsertMany(
    "upsertRow",
    target,
    (req) => [idOf(req)],
    (row, req) => upsert(row as TargetRow<T> | undefined, req),
    opts as UpsertOptions<AnyRow, P, B> | undefined,
  );
}

/**
 * {@link upsertRow} for several rows at once: `idsOf(req)` names them (at
 * least one), `upsert(row, req, id)` returns each one's predicted row from
 * the server's (`undefined`: not held) — a decision recorded for every task
 * of a list, some of which have none yet. Each absent row enters the reads
 * that admit it, like `upsertRow`'s; `set: (req, id) => fields` is compared
 * per row.
 *
 * ```ts
 * effect: (on) =>
 *   upsertRows(on, launchDecisions, ({ body }) => body.taskIds,
 *     (row, { body }, taskId) => ({ ...row, taskId, decision: body.decision, decidedAt: new Date() }),
 *     { set: ({ body }) => ({ decision: body.decision }) }),
 * ```
 */
export function upsertRows<T extends PredictTarget, P, B>(
  _on: EffectOn<P, B>,
  target: T,
  idsOf: (req: EffectRequest<P, B>) => readonly string[],
  upsert: NoInfer<
    (
      row: TargetRow<T> | undefined,
      req: EffectRequest<P, B>,
      id: string,
    ) => TargetRow<T>
  >,
  opts?: NoInfer<UpsertOptions<TargetRow<T>, P, B>>,
): EndpointEffect<P, B> {
  return upsertMany(
    "upsertRows",
    target,
    idsOf,
    (row, req, id) => upsert(row as TargetRow<T> | undefined, req, id),
    opts as UpsertOptions<AnyRow, P, B> | undefined,
  );
}

function upsertMany<P, B>(
  name: string,
  target: PredictTarget,
  idsOf: (req: EffectRequest<P, B>) => readonly string[],
  upsert: (row: unknown, req: EffectRequest<P, B>, id: string) => unknown,
  opts: UpsertOptions<AnyRow, P, B> | undefined,
): EndpointEffect<P, B> {
  const subject = predictSubject(target);
  const where = `${name}(${subject})`;
  checkBudget(where, opts as PredictOptions | undefined);
  const setOf = opts?.set;
  return minted<P, B>([
    part(
      freezeData("upsert", subject, opts as never),
      opts as PredictOptions<P, B> | undefined,
      (r) => {
        const ids = idsOf(r).map((id) => checkId(where, id));
        if (ids.length === 0) {
          throw new Error(
            `${where}: the upsert names no row — a predicted write names the rows it changes.`,
          );
        }
        return ids.map((id) => {
          const set =
            setOf === undefined ? null : Object.freeze({ ...setOf(r, id) });
          return Object.freeze({
            kind: "row" as const,
            subject,
            id,
            set,
            removes: false,
            enters: true,
            apply: (row: AnyRow | undefined) => upsert(row, r, id) as AnyRow,
            confirmedBy: set === null ? null : holds(set),
          });
        });
      },
    ),
  ]);
}

/**
 * The free-form reducer over a set of `target`'s rows — an increment, a rank
 * rewrite: `idsOf(req)` names the rows, `reduce(rows, req)` returns the
 * predicted ones (the rows of `idsOf` the reader holds, in no particular
 * order). A held row the reducer OMITS is removed from the read — so
 * `() => []` removes every named row, and `rows.filter(…)` some of them. It
 * declares no compared fields, so it is confirmed by the write's commit — a
 * frame landing after the ack can no longer make it vanish and return.
 *
 * Over an exposure (`shape.exposure`, {@link PredictPatchTarget}) the reducer
 * sees each held row's exposed slice (`{ playCount, lastPlayedAt }`) and
 * returns ONE next slice per slice, in order (it cannot remove the row —
 * the row is the entity's); a row carrying no such slice is left as it is.
 *
 * A reducer that rewrites the field a read is ordered by (a rank) moves the
 * row within the rows that read holds; one moved past them leaves until the
 * server's frame brings it where it lands.
 */
export function applyRows<T extends PredictPatchTarget, P, B>(
  _on: EffectOn<P, B>,
  target: T,
  idsOf: (req: EffectRequest<P, B>) => readonly string[],
  // `NoInfer`: the reducer is typed by `target`, never a source of `T` — so
  // its literals are checked against the fields, not widened mid-inference.
  reduce: NoInfer<
    (
      rows: readonly TargetRow<T>[],
      req: EffectRequest<P, B>,
    ) => readonly TargetRow<T>[]
  >,
  opts?: PredictOptions<P, B>,
): EndpointEffect<P, B> {
  const subject = patchSubject(target);
  const where = `applyRows(${subject})`;
  checkBudget(where, opts as PredictOptions);
  const lens = lensOf(target);
  const reduceRows = (rows: readonly AnyRow[], r: EffectRequest<P, B>) => {
    const run = reduce as unknown as (
      rows: readonly AnyRow[],
      req: EffectRequest<P, B>,
    ) => readonly AnyRow[];
    if (lens === WHOLE_ROW) return run(rows, r);
    const carrying = rows.filter((row) => lens.read(row) !== undefined);
    if (carrying.length === 0) return rows;
    const next = run(
      carrying.map((row) => lens.read(row)!),
      r,
    );
    if (next.length !== carrying.length) {
      throw new Error(
        `${where}: an exposure's reducer returned ${next.length} slices for ${carrying.length} — it maps each slice to its next, in order.`,
      );
    }
    const written = new Map(
      carrying.map((row, i) => [row, lens.write(row, next[i]!)] as const),
    );
    return rows.map((row) => written.get(row) ?? row);
  };
  return minted<P, B>([
    part(freezeData("rows", subject, opts as never), opts, (r) => {
      const ids = Object.freeze(idsOf(r).map((id) => checkId(where, id)));
      if (ids.length === 0) {
        throw new Error(
          `${where}: the reducer names no row — a predicted write names the rows it changes.`,
        );
      }
      return [
        Object.freeze({
          kind: "rows" as const,
          subject,
          ids,
          apply: (rows: readonly AnyRow[]) => reduceRows(rows, r),
        }),
      ];
    }),
  ]);
}

/**
 * A target's filterable fields — what a `patchWhere` / `removeWhere` filter
 * may name: an entity's fields with a filter domain, or a collection's
 * filterable listed fields plus its KEY columns — its id and its `all.by`
 * scope — which a predicate over the rows a reader holds names as often as
 * any (an extension shape's `taskId`), though no list filters by them.
 */
function targetFilterable(target: PredictTarget): Filterable {
  const out: Record<string, { domain: FilterDomainId }> = {};
  if ((target as { kind?: unknown }).kind === "entity") {
    for (const [name, field] of Object.entries((target as EntityRef).fields)) {
      const domain = fieldDomain(field);
      if (domain !== null) out[name] = { domain };
    }
  } else {
    const c = target as LiveRowsCollection<unknown> & {
      readonly all?: { readonly all?: { readonly by?: readonly string[] } };
    };
    for (const f of Object.values(c.fields)) {
      if (f.domain !== null) out[f.key] = { domain: f.domain };
    }
    const shape = (c.row as unknown as { shape: Record<string, unknown> })
      .shape;
    for (const key of [c.id, ...(c.all?.all?.by ?? [])]) {
      if (key in out) continue;
      const domain = schemaDomain(shape[key]);
      if (domain !== null) out[key] = { domain };
    }
  }
  return Object.freeze(out) as Filterable;
}

/** The canonical filter a where-part targets — never "every row" by omission. */
function targetFilter(
  where: string,
  filter: Filter,
  filterable: Filterable,
): Filter {
  const canonicalFilter = canonicalizeFilter(filter, filterable);
  if (canonicalFilter === undefined) {
    throw new Error(
      `${where}: the filter matches every row (an empty \`and\`) — name the rows the write changes.`,
    );
  }
  return canonicalFilter;
}

/**
 * Patch every row of `target` a reader HOLDS that matches `filterOf(req)` — a
 * write over a predicate (all of a song's track views, every notification):
 * `patchOf(row, req)` is what it sets on each. The filter names the target's
 * filterable fields (checked at dispatch, like a collection's `membership`);
 * a read whose rows lack a column it names is left to the server's frame.
 *
 * ```ts
 * effect: (on) =>
 *   patchWhere(on, trackViewsEntityRef,
 *     ({ params }) => ({ column: "songId", op: "eq", operand: params.songId }),
 *     () => ({ muted: false })),
 * ```
 *
 * A row the reader does not hold predicts nothing; confirmed by the write's
 * commit.
 */
export function patchWhere<T extends PredictTarget, P, B>(
  _on: EffectOn<P, B>,
  target: T,
  filterOf: (req: EffectRequest<P, B>) => Filter,
  patchOf: NoInfer<
    (row: TargetRow<T>, req: EffectRequest<P, B>) => Partial<TargetRow<T>>
  >,
  opts?: PredictOptions<P, B>,
): EndpointEffect<P, B> {
  const subject = predictSubject(target);
  const where = `patchWhere(${subject})`;
  checkBudget(where, opts as PredictOptions);
  const filterable = targetFilterable(target);
  return minted<P, B>([
    part(freezeData("patch-where", subject, opts as never), opts, (r) => [
      Object.freeze({
        kind: "where" as const,
        subject,
        filter: targetFilter(where, filterOf(r), filterable),
        filterable,
        apply: (row: AnyRow) => ({
          ...row,
          ...(patchOf(row as unknown as TargetRow<T>, r) as AnyRow),
        }),
      }),
    ]),
  ]);
}

/** Remove every row of `target` a reader holds that matches `filterOf(req)` (see {@link patchWhere}). */
export function removeWhere<P, B>(
  _on: EffectOn<P, B>,
  target: PredictTarget,
  filterOf: (req: EffectRequest<P, B>) => Filter,
  opts?: PredictOptions<P, B>,
): EndpointEffect<P, B> {
  const subject = predictSubject(target);
  const where = `removeWhere(${subject})`;
  checkBudget(where, opts as PredictOptions);
  const filterable = targetFilterable(target);
  return minted<P, B>([
    part(freezeData("remove-where", subject, opts as never), opts, (r) => [
      Object.freeze({
        kind: "where" as const,
        subject,
        filter: targetFilter(where, filterOf(r), filterable),
        filterable,
        apply: () => undefined,
      }),
    ]),
  ]);
}

/**
 * Patch one tuple of a live value: `paramsOf(req)` names the tuple (the
 * params `useLive(value, params)` reads — canonicalized, so an absent
 * optional one is one tuple however it is spelled; `() => ({})` for a
 * param-less value), `reduce(value, req)` returns the predicted value from
 * the server's. Applied inside `useLive(value, params)` (and `useLiveReader`
 * answering from an observed tuple); confirmed by the write's commit.
 *
 * ```ts
 * effect: (on) =>
 *   patchValue(on, prototypePicks, ({ params }) => ({ name: params.name }),
 *     (picks, { body }) => ({ ...picks, [body.slot]: body.pick })),
 * ```
 */
export function patchValue<T, VP extends Record<string, string>, P, B>(
  _on: EffectOn<P, B>,
  value: LiveValue<T, VP, LiveValueOrigin>,
  paramsOf: NoInfer<(req: EffectRequest<P, B>) => VP>,
  reduce: NoInfer<(value: T, req: EffectRequest<P, B>) => T>,
  opts?: PredictOptions<P, B>,
): EndpointEffect<P, B> {
  const where = `patchValue(${value.key})`;
  checkBudget(where, opts as PredictOptions);
  const optional = (value as { optionalParams?: readonly string[] })
    .optionalParams;
  const data: LiveEffectPart = Object.freeze({
    kind: "value",
    key: value.key,
    ...(opts?.confirmWithinMs === undefined
      ? {}
      : { confirmWithinMs: opts.confirmWithinMs }),
  });
  return minted<P, B>([
    part(data, opts, (r) => {
      const raw = paramsOf(r) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) {
        if (v !== undefined && typeof v !== "string") {
          throw new Error(
            `${where}: param ${k} is ${JSON.stringify(v)} — a value's params are strings.`,
          );
        }
      }
      return [
        Object.freeze({
          kind: "value" as const,
          subject: valueSubject(value.key),
          key: value.key,
          params: Object.freeze({ ...canonicalParams(raw, optional) }),
          apply: (v: unknown) => reduce(v as T, r),
        }),
      ];
    }),
  ]);
}

/**
 * The effect depends on the request: `keyOf(req)` picks one of `branches`,
 * each an effect built on the same `on` (so the definition still resolves its
 * effect once). A key with no branch throws at dispatch — every outcome the
 * request can name is declared.
 *
 * ```ts
 * effect: (on) =>
 *   choose(on, ({ body }) => (body.mode === "score" ? "score" : "set"), {
 *     score: removeRow(on, swingEntityRef, ({ params }) => params.songId),
 *     set: upsertRow(on, swingEntityRef, ({ params }) => params.songId, (row, { params, body }) => …),
 *   }),
 * ```
 */
export function choose<P, B, K extends string>(
  _on: EffectOn<P, B>,
  keyOf: (req: EffectRequest<P, B>) => K,
  branches: { readonly [Key in K]: EndpointEffect<P, B> },
): EndpointEffect<P, B> {
  const table = new Map<string, readonly Part[]>();
  for (const [k, e] of Object.entries(branches) as [
    string,
    EndpointEffect<P, B>,
  ][]) {
    table.set(k, partsOf(e));
  }
  if (table.size === 0) {
    throw new Error("choose: no branch — declare one effect per outcome.");
  }
  const data: LiveEffectPart = Object.freeze({
    kind: "choose",
    branches: Object.freeze(
      Object.fromEntries(
        [...table].map(([k, parts]) => [
          k,
          Object.freeze(parts.map((p) => p.part)),
        ]),
      ),
    ),
  });
  return minted<P, B>([
    {
      part: data,
      resolve: (req) => {
        const key = keyOf(req as EffectRequest<P, B>);
        const parts = table.get(key);
        if (parts === undefined) {
          throw new Error(
            `choose: the request picked ${JSON.stringify(key)}, which has no branch (${[...table.keys()].join(", ")}).`,
          );
        }
        return resolveParts(parts, req);
      },
    },
  ]);
}

/** Several targets in one effect (each built on the same `on`), applied in order (their own `confirmWithinMs` kept; the tightest wins). */
export function effects<P, B>(
  ...list: readonly [EndpointEffect<P, B>, ...EndpointEffect<P, B>[]]
): EndpointEffect<P, B> {
  return minted<P, B>(list.flatMap(partsOf));
}

function partsOf<P, B>(e: EndpointEffect<P, B>): readonly Part[] {
  return (
    readLiveEffect(e as unknown as EndpointEffect<never, never>) as Minted
  )[LIVE_EFFECT];
}

/**
 * The {@link LiveEffect} an endpoint's `effect` carries. Throws when it was
 * not built by these builders: the endpoints plugin cannot stop another
 * minter, so the reader refuses loudly rather than guess its shape.
 */
export function readLiveEffect(
  effect: EndpointEffect<never, never>,
): LiveEffect {
  const payload = endpointEffectPayload(effect) as Partial<Minted> | undefined;
  if (payload === undefined || !Array.isArray(payload[LIVE_EFFECT])) {
    throw new Error(
      "readLiveEffect: this endpoint effect was not built by network/live's predict builders (patchRow / removeRow / upsertRow / upsertRows / applyRows / patchWhere / removeWhere / patchValue / choose / effects).",
    );
  }
  return payload as LiveEffect;
}
