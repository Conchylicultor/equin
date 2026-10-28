import {
  brandEndpointEffect,
  endpointEffectPayload,
  type EffectOn,
  type EffectRequest,
  type EndpointEffect,
} from "@plugins/infra/plugins/endpoints/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type { FieldsRecord, InferFieldsObject } from "@plugins/fields/core";

// The predict builders: what a WRITE endpoint does to live data, declared on
// the endpoint (`defineEndpoint({ …, effect })`) — design in
// research/2026-10-27-global-predicted-endpoint-effects.md §1.
//
// An effect targets an ENTITY's rows, never a collection: the overlay that
// applies it is keyed by `(entity name, row id)`, so every collection whose
// rows are that entity (`liveCollection({ from })`) shows the prediction —
// collections added later included — with no edit to the effect.
//
// An effect predicts only what the REQUEST decides. A field the server
// derives (a rollup, a status another table drives) or decides (a
// precondition, a minted id) arrives by push, never predicted.
//
// The value a builder returns is endpoints' opaque `EndpointEffect` (the
// endpoints plugin sits below this one); its payload is a `LiveEffect`, read
// back by `readLiveEffect` alone.

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
export interface PredictOptions {
  /**
   * How long the server has to confirm the prediction before the write is
   * reported unconfirmed (the overlay's deadline). Absent: the overlay's
   * default.
   */
  readonly confirmWithinMs?: number;
}

/**
 * One target of a resolved effect — the prediction for one or several rows
 * of one entity, its request already fixed. Pure data plus pure functions:
 * the overlay asks it for the predicted row and whether a server row
 * confirms it, and nothing else.
 */
export type ResolvedLiveTarget =
  | {
      /** A row patched in place, or removed. */
      readonly kind: "row";
      /** The entity's name (`entityRef(name, …)`) — the overlay's key. */
      readonly entity: string;
      readonly id: string;
      /**
       * The compared fields (`patchRow`'s `set`), or `null` for a removal.
       * The overlay reads them to decide a membership exit's confirmation.
       */
      readonly set: Readonly<Record<string, unknown>> | null;
      /**
       * The predicted row from the server's (`undefined`: not held).
       * A patch of a row not held predicts nothing (`undefined` stays).
       */
      readonly apply: (
        row: Readonly<Record<string, unknown>> | undefined,
      ) => Readonly<Record<string, unknown>> | undefined;
      /** Whether this server row (or its absence) already shows the write. */
      readonly confirmedBy: (
        row: Readonly<Record<string, unknown>> | undefined,
      ) => boolean;
    }
  | {
      /**
       * A free-form reducer over a set of rows (`applyRows`). It declares no
       * compared fields, so only the write's ack confirms it.
       */
      readonly kind: "rows";
      readonly entity: string;
      readonly ids: readonly string[];
      /** The predicted rows from the server's rows of `ids` that are held. */
      readonly apply: (
        rows: readonly Readonly<Record<string, unknown>>[],
      ) => readonly Readonly<Record<string, unknown>>[];
    };

/** An effect resolved against one request. */
export interface ResolvedLiveEffect {
  readonly targets: readonly ResolvedLiveTarget[];
  /** The tightest `confirmWithinMs` any part declared, or absent. */
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
      readonly kind: "patch";
      readonly entity: string;
      readonly confirmWithinMs?: number;
    }
  | {
      readonly kind: "remove";
      readonly entity: string;
      readonly confirmWithinMs?: number;
    }
  | {
      readonly kind: "rows";
      readonly entity: string;
      readonly confirmWithinMs?: number;
    };

/** Marks a payload as minted here, so a foreign one fails `readLiveEffect` loudly. */
const LIVE_EFFECT = Symbol("live-effect");

type AnyReq = EffectRequest<unknown, unknown>;
/** One part as minted: its data, and how it resolves against a request. */
interface Part {
  readonly part: LiveEffectPart;
  readonly resolve: (req: AnyReq) => readonly ResolvedLiveTarget[];
}

interface Minted extends LiveEffect {
  /** The parts with their resolvers — what `effects(...)` concatenates. */
  readonly [LIVE_EFFECT]: readonly Part[];
}

function minted<P, B>(parts: readonly Part[]): EndpointEffect<P, B> {
  const budgets = parts
    .map((p) => p.part.confirmWithinMs)
    .filter((ms): ms is number => ms !== undefined);
  const confirmWithinMs =
    budgets.length === 0 ? undefined : Math.min(...budgets);
  const payload: Minted = Object.freeze({
    [LIVE_EFFECT]: Object.freeze([...parts]),
    parts: Object.freeze(parts.map((p) => p.part)),
    resolve: (req: AnyReq): ResolvedLiveEffect =>
      Object.freeze({
        targets: Object.freeze(parts.flatMap((p) => p.resolve(req))),
        ...(confirmWithinMs === undefined ? {} : { confirmWithinMs }),
      }),
  });
  return brandEndpointEffect<P, B>(payload);
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

/**
 * Every builder takes `on` first — the typed request `defineEndpoint` hands
 * its `effect` callback (endpoints' `EffectOn`) — so its request callbacks are
 * typed by the route with no annotation (a bare nested builder call would be
 * checked before the route is inferred, and get `params: unknown`).
 *
 * Patch one row of `entity`: `idOf(req)` names it, `patchOf(req)` says what
 * the write sets (`set`, compared for confirmation) and what is only shown
 * (`approx`). `req` is the endpoint's request — `params` typed by its route,
 * `body` by its body schema — and the patch's keys and values are checked
 * against the entity's fields.
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
export function patchRow<F extends FieldsRecord, P, B>(
  _on: EffectOn<P, B>,
  entity: EntityRef<string, F>,
  idOf: (req: EffectRequest<P, B>) => string,
  // `NoInfer`: the patch is typed by `entity`, never a source of `F` — a
  // zero-argument `() => ({ set: { status: "done" } })` is not deferred like
  // a callback, so without it its literal would be widened mid-inference.
  patchOf: NoInfer<
    (req: EffectRequest<P, B>) => RowPatch<InferFieldsObject<F>>
  >,
  opts?: PredictOptions,
): EndpointEffect<P, B> {
  const where = `patchRow(${entity.name})`;
  checkBudget(where, opts);
  return minted<P, B>([
    {
      part: freezePart("patch", entity.name, opts),
      resolve: (req) => {
        const r = req as EffectRequest<P, B>;
        const id = checkId(where, idOf(r));
        const { set, approx } = patchOf(r) as {
          set: Record<string, unknown>;
          approx?: Record<string, unknown>;
        };
        const fixedSet = Object.freeze({ ...set });
        const shown = Object.freeze({ ...set, ...approx });
        return [
          Object.freeze({
            kind: "row" as const,
            entity: entity.name,
            id,
            set: fixedSet,
            apply: (row: Readonly<Record<string, unknown>> | undefined) =>
              row === undefined ? undefined : { ...row, ...shown },
            confirmedBy: (row: Readonly<Record<string, unknown>> | undefined) =>
              row !== undefined &&
              Object.entries(fixedSet).every(([k, v]) => sameValue(row[k], v)),
          }),
        ];
      },
    },
  ]);
}

/** Remove one row of `entity` (`idOf(req)`): it leaves every collection of it at once. */
export function removeRow<P, B>(
  _on: EffectOn<P, B>,
  entity: EntityRef,
  idOf: (req: EffectRequest<P, B>) => string,
  opts?: PredictOptions,
): EndpointEffect<P, B> {
  const where = `removeRow(${entity.name})`;
  checkBudget(where, opts);
  return minted<P, B>([
    {
      part: freezePart("remove", entity.name, opts),
      resolve: (req) => {
        const id = checkId(where, idOf(req as EffectRequest<P, B>));
        return [
          Object.freeze({
            kind: "row" as const,
            entity: entity.name,
            id,
            set: null,
            apply: () => undefined,
            confirmedBy: (row: Readonly<Record<string, unknown>> | undefined) =>
              row === undefined,
          }),
        ];
      },
    },
  ]);
}

/**
 * The free-form reducer over a set of `entity`'s rows — an upsert onto a
 * maybe-absent row, an increment, a conditional, a rank rewrite: `idsOf(req)`
 * names the rows, `reduce(rows, req)` returns the predicted ones (the rows
 * of `idsOf` the reader holds, in no particular order). It declares no
 * compared fields, so only the write's ack confirms it.
 */
export function applyRows<F extends FieldsRecord, P, B>(
  _on: EffectOn<P, B>,
  entity: EntityRef<string, F>,
  idsOf: (req: EffectRequest<P, B>) => readonly string[],
  // `NoInfer`: the reducer is typed by `entity`, never a source of `F` — so
  // its literals are checked against the fields, not widened mid-inference.
  reduce: NoInfer<
    (
      rows: readonly InferFieldsObject<F>[],
      req: EffectRequest<P, B>,
    ) => readonly InferFieldsObject<F>[]
  >,
  opts?: PredictOptions,
): EndpointEffect<P, B> {
  const where = `applyRows(${entity.name})`;
  checkBudget(where, opts);
  return minted<P, B>([
    {
      part: freezePart("rows", entity.name, opts),
      resolve: (req) => {
        const r = req as EffectRequest<P, B>;
        const ids = Object.freeze(idsOf(r).map((id) => checkId(where, id)));
        return [
          Object.freeze({
            kind: "rows" as const,
            entity: entity.name,
            ids,
            apply: (rows: readonly Readonly<Record<string, unknown>>[]) =>
              reduce(
                rows as unknown as readonly InferFieldsObject<F>[],
                r,
              ) as unknown as readonly Readonly<Record<string, unknown>>[],
          }),
        ];
      },
    },
  ]);
}

/** Several targets in one effect (each built on the same `on`), applied in order (their own `confirmWithinMs` kept; the tightest wins). */
export function effects<P, B>(
  ...list: readonly [EndpointEffect<P, B>, ...EndpointEffect<P, B>[]]
): EndpointEffect<P, B> {
  return minted<P, B>(
    list.flatMap(
      (e) =>
        (
          readLiveEffect(e as unknown as EndpointEffect<never, never>) as Minted
        )[LIVE_EFFECT],
    ),
  );
}

function freezePart(
  kind: LiveEffectPart["kind"],
  entity: string,
  opts: PredictOptions | undefined,
): LiveEffectPart {
  return Object.freeze({
    kind,
    entity,
    ...(opts?.confirmWithinMs === undefined
      ? {}
      : { confirmWithinMs: opts.confirmWithinMs }),
  });
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
      "readLiveEffect: this endpoint effect was not built by network/live's predict builders (patchRow / removeRow / applyRows / effects).",
    );
  }
  return payload as LiveEffect;
}
