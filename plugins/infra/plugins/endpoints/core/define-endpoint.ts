import type { z } from "zod";
import { type Codec, isCodec, json } from "./codec";
import type { ExtractParams } from "./route-params";
import { extractMethod, extractPath } from "./route-params";
import type { MachineFeature } from "./needs-machine";
import type { AgentWrite } from "./agent-write";
import type { EndpointAccess } from "@plugins/framework/plugins/principal/core";
import {
  EFFECT_ON,
  type EffectOn,
  type EndpointEffect,
} from "./endpoint-effect";
import {
  PREDICTION_GAPS,
  UNPREDICTED_REASONS,
  type InternalDecl,
  type PredictionGap,
  type Unpredicted,
  type UnpredictedReason,
} from "./prediction";

/** The methods a browser may send through `fetchEndpoint` / `useEndpointMutation`. */
type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";
const WRITE_METHODS: ReadonlySet<string> = new Set<WriteMethod>([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Why a read endpoint is refused by the browser's write clients — the sentence
 * tsc prints when a GET def is passed to one, and the error a cast past tsc
 * throws at runtime.
 */
const READ_MARKER =
  "GET is a read: declare it live (liveValue / liveCollection) and read it with useLive (useLiveReader in an event handler); fetchEndpoint / useEndpointMutation send writes only" as const;
export type ReadMarker = typeof READ_MARKER;

/**
 * The `read` marker a route derives: `undefined` for a literal write route,
 * {@link ReadMarker} otherwise. An allow-list, so it fails closed: a GET (or
 * HEAD / OPTIONS), a GET|POST union, and a wide `string` route are all reads to
 * the write clients. A wide route keeps `undefined` in its type so every
 * literal def stays assignable to `EndpointDef<string, …>` (`implement`,
 * `callEndpoint`, registries) — yet is still not a {@link WriteEndpoint}.
 */
export type ReadOf<Route extends string> = string extends Route
  ? ReadMarker | undefined
  : [Route] extends [`${WriteMethod} ${string}`]
    ? undefined
    : ReadMarker;

/**
 * What the browser's write clients (`fetchEndpoint`, `useEndpointMutation`,
 * `readNdjson`) take beside the def: a contract whose route is a write. A GET
 * def fails it with the {@link ReadMarker} sentence; a generic wrapper keeps
 * compiling by constraining its def with `& WriteEndpoint` too.
 */
export type WriteEndpoint = { readonly read: undefined };

/** The `read` marker of a route, at runtime (what `defineEndpoint` stamps). */
function readMarkerOf(route: string): ReadMarker | undefined {
  return WRITE_METHODS.has(extractMethod(route)) ? undefined : READ_MARKER;
}

/** What every endpoint contract carries, portable or desktop-only. */
interface EndpointContract<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> {
  readonly route: Route;
  readonly method: string;
  readonly path: string;
  /**
   * Derived from the route, never declared: `undefined` on a write, the
   * {@link ReadMarker} sentence on a read. The browser's write clients take
   * only `& WriteEndpoint` (tsc), and `fetchEndpoint` throws the sentence when
   * a cast gets a read past tsc. Every other client (`callEndpoint`, `assetPath`,
   * `implement`, e2e) ignores it.
   */
  readonly read: ReadOf<Route>;
  readonly bodyCodec?: Codec<TBody>;
  readonly responseCodec?: Codec<TResponse>;
  readonly querySchema?: z.ZodType<TQuery>;
  /**
   * Bound how many handler bodies run concurrently for this route (a per-route
   * semaphore in `implement`). Use for CPU/IO-heavy handlers — e.g. ones that
   * spawn `git archive | tar` — so a burst can't saturate the box. Omit = no cap.
   */
  readonly concurrency?: number;
  /**
   * Collapse concurrent identical GETs onto one in-flight handler invocation
   * (keyed by method + path + query). A burst of N duplicate requests does one
   * unit of work; each caller still gets its own encoded Response. GET-only —
   * `implement` throws for any other method, since deduping a mutation would
   * drop a caller's distinct side effect.
   */
  readonly dedupe?: boolean;
  /**
   * Per-route slow-op threshold (ms). When this route's `http` span exceeds it,
   * the slow-ops pipeline files a report — the HTTP twin of
   * `defineJob({ slowThresholdMs })`. Use it to hold a latency-sensitive endpoint
   * to a tighter bar than the global `slow-op` `httpMs` default (a regression
   * backstop). Omit = the global default applies.
   */
  readonly slowThresholdMs?: number;
  /**
   * Why an agent session may send this WRITE to main (see {@link AgentWrite}).
   * Absent = a normal write: main's backend refuses it with a 403 when the
   * request carries the agent-origin headers. Write endpoints only — `implement`
   * throws for a GET. The server reads only this field.
   */
  readonly agentWrite?: AgentWrite;
  /**
   * An agent session's write here may be recorded in an agent-write ledger
   * (`request-origin/agent-write-ledger`) and undone when the session closes —
   * so the agent browser's write drain must wait for it before reverting.
   *
   * Absent on a write = it records nothing a revert undoes: `fetchEndpoint`
   * stamps `UNREVERTED_WRITE_HEADER` on the request and the drain does not wait
   * for it. Getting this wrong is loud, never silent: a ledger refuses (throws)
   * to record an agent write whose request carried that stamp. Write endpoints
   * only — `implement` throws for a GET.
   */
  readonly agentReverted?: true;
  /**
   * Who may call this route, resolved: `"owner"` unless the declaration said
   * `access: { public: "<reason>" }`. The socket hosts refuse an anonymous
   * caller (the gateway's `X-Equin-Principal` verdict) of an owner route with
   * `403 cross-site-refused` before the handler runs (`framework/principal`'s
   * `gateByPrincipal`, reading the `access` `implement` attaches to the handler).
   */
  readonly access: EndpointAccess;
  /** Phantom field to carry the params type. Never set at runtime. */
  readonly __params?: TParams;
}

/**
 * A portable endpoint: served by every host's `server/` (`implement`). Its
 * `needsMachine` is absent, so a desktop-only {@link MachineEndpointDef} is not
 * one — not even through a variable typed `EndpointDef`, which would let a
 * caller read its answer without the unavailable arm.
 */
export interface EndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> extends EndpointContract<Route, TParams, TBody, TResponse, TQuery> {
  readonly needsMachine?: undefined;
  /** Unpredicted: a {@link PredictedEndpointDef} is not one (see there). */
  readonly effect?: undefined;
  /** Browser-callable: an {@link InternalEndpointDef} is not one (see there). */
  readonly internal?: undefined;
  /**
   * Why this write is not predicted (a reason, or a gap: debt) — metadata for
   * the routes facet. Absent on a read and on a telemetry write.
   */
  readonly unpredicted?: Unpredicted;
}

/**
 * A desktop-only endpoint (`defineEndpoint({ …, needsMachine: { feature } })`):
 * served only by a plugin's `machine/` half (`implementMachine` from
 * `endpoints/machine`), and answered `unavailable` by every client whose
 * transport has no computer behind it (`fetchEndpoint` → `MachineResult`).
 */
export interface MachineEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> extends EndpointContract<Route, TParams, TBody, TResponse, TQuery> {
  readonly needsMachine: MachineFeature;
  /** Unpredicted: a {@link PredictedMachineEndpointDef} is not one. */
  readonly effect?: undefined;
  /** Browser-callable: an {@link InternalMachineEndpointDef} is not one. */
  readonly internal?: undefined;
  /** Why this write is not predicted — see {@link EndpointDef.unpredicted}. */
  readonly unpredicted?: Unpredicted;
}

/**
 * A portable WRITE endpoint declared with its predicted effect
 * (`defineEndpoint({ …, effect })` — see {@link EndpointEffect}). Its one
 * browser client is `network/live`'s `useLiveMutation`, which shows the
 * effect at once and has no pending state: `useEndpointMutation` and
 * `FetchEndpoint` refuse it (tsc — their defs say `effect?: undefined`), so
 * no surface can await it behind a spinner. The server serves it like any
 * portable endpoint (`implement`), and off the page `callEndpoint` calls it.
 */
export interface PredictedEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> extends EndpointContract<Route, TParams, TBody, TResponse, TQuery> {
  readonly needsMachine?: undefined;
  readonly effect: EndpointEffect<TParams, TBody>;
  readonly internal?: undefined;
  readonly unpredicted?: undefined;
}

/** {@link PredictedEndpointDef}'s desktop-only twin (`implementMachine`). */
export interface PredictedMachineEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> extends EndpointContract<Route, TParams, TBody, TResponse, TQuery> {
  readonly needsMachine: MachineFeature;
  readonly effect: EndpointEffect<TParams, TBody>;
  readonly internal?: undefined;
  readonly unpredicted?: undefined;
}

/**
 * A portable WRITE endpoint no browser calls (`defineEndpoint({ …, internal:
 * { why } })`): a server → central RPC, a CLI or e2e hook. The browser's
 * clients — `FetchEndpoint`, `useEndpointMutation`, `readNdjson`,
 * `useLiveMutation` — refuse it (tsc: their defs say `internal?: undefined`).
 * `implement` serves it, `callEndpoint` and e2e flows call it.
 */
export interface InternalEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> extends EndpointContract<Route, TParams, TBody, TResponse, TQuery> {
  readonly needsMachine?: undefined;
  readonly effect?: undefined;
  readonly unpredicted?: undefined;
  readonly internal: InternalDecl;
}

/** {@link InternalEndpointDef}'s desktop-only twin (`implementMachine`). */
export interface InternalMachineEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> extends EndpointContract<Route, TParams, TBody, TResponse, TQuery> {
  readonly needsMachine: MachineFeature;
  readonly effect?: undefined;
  readonly unpredicted?: undefined;
  readonly internal: InternalDecl;
}

/** Every kind of endpoint definition — what a request is built and read from. */
export type AnyEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> =
  | EndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | PredictedEndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | PredictedMachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | InternalEndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | InternalMachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>;

const contracts = new WeakMap<object, object>();

/**
 * A predicted definition as its plain, unpredicted contract (the effect
 * stripped; one stable object per definition) — so `network/live`'s
 * predicted-write client sends it through the ordinary `FetchEndpoint` once
 * it has applied the effect. For `network/live` only (lint
 * `endpoints/no-endpoint-effect-internals`): anywhere else it is the escape
 * hatch back to an awaited, spinner-showing call the type split exists to
 * forbid.
 */
export function endpointContractOf<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: PredictedMachineEndpointDef<
    Route,
    TParams,
    TBody,
    TResponse,
    TQuery
  >,
): MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>;
export function endpointContractOf<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: PredictedEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
): EndpointDef<Route, TParams, TBody, TResponse, TQuery>;
export function endpointContractOf(endpoint: {
  readonly effect: unknown;
}): object {
  let contract = contracts.get(endpoint);
  if (contract === undefined) {
    const { effect: _effect, ...rest } = endpoint;
    contract = Object.freeze(rest);
    contracts.set(endpoint, contract);
  }
  return contract;
}

/** A body/response spec accepts a bare Zod schema (JSON) or an explicit codec. */
type Spec<T> = z.ZodType<T> | Codec<T>;

/**
 * Extracts the payload type from a spec. Inferring `B`/`R` as the *spec object*
 * type and extracting via this conditional avoids the union-variance inference
 * regression a direct `z.ZodType<T> | Codec<T>` parameter would cause (`Codec<T>`
 * is invariant in `T`).
 */
type SpecType<S> =
  S extends Codec<infer U> ? U : S extends z.ZodType<infer U> ? U : void;

/** A route whose method cannot write (GET / HEAD / OPTIONS). */
type ReadRoute = `${"GET" | "HEAD" | "OPTIONS"} ${string}`;

/** What `defineEndpoint` takes, whichever host serves it. */
interface EndpointOptions<Route extends string, B, R, TQuery> {
  route: Route;
  body?: B;
  response?: R;
  query?: z.ZodType<TQuery>;
  concurrency?: number;
  dedupe?: boolean;
  slowThresholdMs?: number;
  /** A read cannot write, so a GET declaring it is a tsc error. */
  agentReverted?: Route extends ReadRoute ? never : true;
  /**
   * Opens the route to an anonymous caller — another site, a cross-site
   * navigation — and says why (`{ public: "<reason>" }`). Absent = owner-only,
   * the default; `"owner"` has no spelling here, so the safe answer is the one
   * a forgotten field gives.
   */
  access?: { public: string };
}

/**
 * The predicted effect a WRITE declares, built on the route's typed request
 * (`effect: (on) => patchRow(on, entity, ({ params }) => params.id, …)` —
 * see {@link EffectOn} for why a callback).
 */
type EffectBuilder<Route extends string, B> = (
  on: EffectOn<ExtractParams<Route>, SpecType<B>>,
) => EndpointEffect<ExtractParams<Route>, SpecType<B>>;

/** `T` on a write route, `never` on a read (a GET declaring it is a tsc error). */
type OnWrite<Route extends string, T> = Route extends ReadRoute ? never : T;

/**
 * The agent-write marker a write that decides its prediction may carry: only
 * `"agent-control"` — a telemetry write is the {@link TelemetryArm}, its
 * decision derived, never declared twice.
 */
type DecidedAgentWrite<Route extends string> = OnWrite<Route, "agent-control">;

// ── The decision: every write takes exactly ONE arm ──────────────────────────
// (research/2026-10-28-global-endpoint-prediction-decision.md §1). Each arm
// types the others' keys `?: never`, so none or two is a tsc error and the
// decision has one spelling. A read takes none (`ReadArm`).

/** Predicted: its one browser client is `useLiveMutation`. */
type PredictedArm<Route extends string, B> = {
  effect: OnWrite<Route, EffectBuilder<Route, B>>;
  unpredicted?: never;
  internal?: never;
  agentWrite?: DecidedAgentWrite<Route>;
};

/** Not predicted, for a stated reason or a gap (debt) — see {@link Unpredicted}. */
type UnpredictedArm<Route extends string> = {
  unpredicted: OnWrite<Route, Unpredicted>;
  effect?: never;
  internal?: never;
  agentWrite?: DecidedAgentWrite<Route>;
};

/** No browser client — see {@link InternalDecl}. */
type InternalArm<Route extends string> = {
  internal: OnWrite<Route, InternalDecl>;
  effect?: never;
  unpredicted?: never;
  agentWrite?: DecidedAgentWrite<Route>;
};

/** A write of observability data: the decision is `agentWrite` itself. */
type TelemetryArm = {
  agentWrite: "telemetry";
  effect?: never;
  unpredicted?: never;
  internal?: never;
};

/** A read decides nothing: it writes no live data. */
type ReadArm = {
  effect?: never;
  unpredicted?: never;
  internal?: never;
  agentWrite?: never;
};

/** The arms the plain (`EndpointDef`) overloads take, per route. */
type PlainArm<Route extends string> = Route extends ReadRoute
  ? ReadArm
  : UnpredictedArm<Route> | TelemetryArm;

/**
 * What tsc prints when no overload matches: the last overload requires this
 * key, which nothing can supply (`never`), so its "property is missing"
 * error names what to declare.
 */
type Undecided<Route extends string> = Route extends ReadRoute
  ? {
      "a read (GET / HEAD / OPTIONS) declares none of effect, unpredicted, internal, agentWrite": never;
    }
  : {
      'a write declares EXACTLY ONE of: effect: (on) => …  |  unpredicted: { reason, why } or { gap }  |  internal: { why }  |  agentWrite: "telemetry" alone': never;
    };

/**
 * What tsc types a declaration that fits no overload as (error recovery
 * only — it is never returned): its kind keys are `any`, so it fits every
 * def kind and the declaration's own error is the only one, instead of a
 * cascade through every `implement` and client of it.
 */
type UndecidedEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> = EndpointContract<Route, TParams, TBody, TResponse, TQuery> & {
  readonly needsMachine: any;
  readonly effect: any;
  readonly internal: any;
  readonly unpredicted: any;
};

/**
 * Never matches (its required key is `never`) — and FIRST on purpose: when a
 * declaration fits no overload, tsc types the call by the first one, so an
 * undecided declaration is an {@link UndecidedEndpointDef} and only its own
 * line errors (not every `implement` / client of it). Its twin LAST is the one
 * tsc reports.
 */
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine?: MachineFeature;
    // Every decision key, loosely: so the one error left is the missing
    // `Undecided` key — the sentence — and an `effect` callback is still typed.
    effect?: EffectBuilder<Route, B>;
    unpredicted?: Unpredicted;
    internal?: InternalDecl;
    agentWrite?: AgentWrite;
  } & Undecided<Route>,
): UndecidedEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
>;
/**
 * Declare an endpoint. With `needsMachine: { feature }` it is desktop-only (a
 * `Machine…Def`, whose every client handles the "not available" answer —
 * tsc); without it, portable.
 *
 * A WRITE decides how its effect reaches the user — exactly one of:
 * - `effect: (on) => …` (built by `network/live`'s `patchRow` / `removeRow` /
 *   `applyRows` / `effects`, typed by this route) → a
 *   {@link PredictedEndpointDef}, sent only through `useLiveMutation`;
 * - `unpredicted: { reason, why }` (an {@link UnpredictedReason}) or
 *   `{ gap }` (a {@link PredictionGap}: debt) → an {@link EndpointDef};
 * - `internal: { why }` → an {@link InternalEndpointDef}, which no browser
 *   client takes;
 * - `agentWrite: "telemetry"` and none of the three → an {@link EndpointDef}.
 *
 * A read declares none of them. Past a cast, every violation throws here.
 */
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    PredictedArm<Route, B> & { needsMachine: MachineFeature },
): PredictedMachineEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    PredictedArm<Route, B> & { needsMachine?: undefined },
): PredictedEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    InternalArm<Route> & { needsMachine: MachineFeature },
): InternalMachineEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    InternalArm<Route> & { needsMachine?: undefined },
): InternalEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    PlainArm<Route> & { needsMachine: MachineFeature },
): MachineEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    PlainArm<Route> & { needsMachine?: undefined },
): EndpointDef<Route, ExtractParams<Route>, SpecType<B>, SpecType<R>, TQuery>;
/**
 * Never matches (its required key is `never`): the overload tsc reports when
 * a declaration fits none above, so the error names what to declare.
 */
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine?: MachineFeature;
    // Every decision key, loosely: so the one error left is the missing
    // `Undecided` key — the sentence — and an `effect` callback is still typed.
    effect?: EffectBuilder<Route, B>;
    unpredicted?: Unpredicted;
    internal?: InternalDecl;
    agentWrite?: AgentWrite;
  } & Undecided<Route>,
): UndecidedEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine?: MachineFeature;
    effect?: EffectBuilder<Route, B>;
    unpredicted?: Unpredicted;
    internal?: InternalDecl;
    agentWrite?: AgentWrite;
  },
): AnyEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
> {
  const decision = resolveDecision(opts);
  const bodyCodec = opts.body
    ? isCodec(opts.body)
      ? opts.body
      : json(opts.body as z.ZodType<unknown>)
    : undefined;
  const responseCodec = opts.response
    ? isCodec(opts.response)
      ? opts.response
      : json(opts.response as z.ZodType<unknown>)
    : undefined;
  return {
    route: opts.route,
    method: extractMethod(opts.route),
    path: extractPath(opts.route),
    read: readMarkerOf(opts.route) as ReadOf<Route>,
    bodyCodec: bodyCodec as Codec<SpecType<B>> | undefined,
    responseCodec: responseCodec as Codec<SpecType<R>> | undefined,
    querySchema: opts.query,
    concurrency: opts.concurrency,
    dedupe: opts.dedupe,
    slowThresholdMs: opts.slowThresholdMs,
    agentWrite: opts.agentWrite,
    agentReverted: opts.agentReverted,
    access: resolveAccess(opts.route, opts.access),
    ...(opts.needsMachine !== undefined
      ? { needsMachine: opts.needsMachine }
      : {}),
    // Built once, here: the builder is pure, and `on` is a phantom.
    ...(opts.effect !== undefined
      ? {
          effect: opts.effect(
            EFFECT_ON as EffectOn<ExtractParams<Route>, SpecType<B>>,
          ),
        }
      : {}),
    ...(decision.kind === "unpredicted"
      ? { unpredicted: decision.unpredicted }
      : {}),
    ...(decision.kind === "internal" ? { internal: decision.internal } : {}),
  } as AnyEndpointDef<
    Route,
    ExtractParams<Route>,
    SpecType<B>,
    SpecType<R>,
    TQuery
  >;
}

/** The decision keys a declaration may carry (one, on a write; none on a read). */
const DECISION_KEYS = ["effect", "unpredicted", "internal"] as const;

/** What a declaration decided, validated. */
type Decision =
  | { kind: "read" }
  | { kind: "predicted" }
  | { kind: "telemetry" }
  | { kind: "unpredicted"; unpredicted: Unpredicted }
  | { kind: "internal"; internal: InternalDecl };

/**
 * The runtime backstop of the options union: tsc refuses all of this, so it
 * fires only on a declaration a cast got past tsc — and names the route and
 * what to declare.
 */
function resolveDecision(opts: {
  route: string;
  effect?: unknown;
  unpredicted?: unknown;
  internal?: unknown;
  agentWrite?: unknown;
}): Decision {
  const { route } = opts;
  const declared = DECISION_KEYS.filter((k) => opts[k] !== undefined);
  if (readMarkerOf(route) !== undefined) {
    if (declared.length > 0) {
      throw new Error(
        `defineEndpoint(${route}): \`${declared.join("` / `")}\` on a read — only a write changes live data; a read declares none of effect / unpredicted / internal.`,
      );
    }
    return { kind: "read" };
  }
  const telemetry = opts.agentWrite === "telemetry";
  if (telemetry && declared.length > 0) {
    throw new Error(
      `defineEndpoint(${route}): agentWrite: "telemetry" is the decision itself — drop \`${declared.join("` / `")}\`.`,
    );
  }
  if (declared.length > 1) {
    throw new Error(
      `defineEndpoint(${route}): declares \`${declared.join("` and `")}\` — a write declares exactly one of effect / unpredicted / internal.`,
    );
  }
  const [arm] = declared;
  if (arm === undefined) {
    if (telemetry) return { kind: "telemetry" };
    throw new Error(
      `defineEndpoint(${route}): a write declares how its effect reaches the user — exactly one of \`effect: (on) => …\` (predicted), \`unpredicted: { reason, why }\` or \`{ gap }\`, \`internal: { why }\`, or \`agentWrite: "telemetry"\`.`,
    );
  }
  if (arm === "effect") return { kind: "predicted" };
  if (arm === "internal") {
    return {
      kind: "internal",
      internal: { why: requireWhy(route, "internal", opts.internal) },
    };
  }
  return { kind: "unpredicted", unpredicted: resolveUnpredicted(route, opts) };
}

function resolveUnpredicted(
  route: string,
  opts: { unpredicted?: unknown },
): Unpredicted {
  const value = opts.unpredicted;
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `defineEndpoint(${route}): unpredicted is { reason, why } or { gap } — got ${JSON.stringify(value)}`,
    );
  }
  const { reason, why, gap } = value as Record<string, unknown>;
  if (gap !== undefined) {
    if (reason !== undefined || why !== undefined) {
      throw new Error(
        `defineEndpoint(${route}): unpredicted takes { reason, why } or { gap }, not both — a gap's reason is its PREDICTION_GAPS entry.`,
      );
    }
    if (typeof gap !== "string" || !Object.hasOwn(PREDICTION_GAPS, gap)) {
      throw new Error(
        `defineEndpoint(${route}): unpredicted.gap ${JSON.stringify(gap)} is not a PredictionGap — one of ${Object.keys(PREDICTION_GAPS).join(", ")} (a closed gap's endpoints declare their effect now).`,
      );
    }
    return { gap: gap as PredictionGap };
  }
  if (typeof reason !== "string" || !UNPREDICTED_REASONS.has(reason)) {
    throw new Error(
      `defineEndpoint(${route}): unpredicted.reason ${JSON.stringify(reason)} is not an UnpredictedReason — one of ${[...UNPREDICTED_REASONS].join(", ")}; or declare { gap } for debt.`,
    );
  }
  return {
    reason: reason as UnpredictedReason,
    why: requireWhy(route, "unpredicted", value),
  };
}

/**
 * A decision's `why`, required and non-empty — the review surface of the
 * decision, checked at declaration the way `access.public` is.
 */
function requireWhy(
  route: string,
  key: "unpredicted" | "internal",
  value: unknown,
): string {
  const why =
    typeof value === "object" && value !== null
      ? (value as { why?: unknown }).why
      : undefined;
  if (typeof why !== "string" || why.trim() === "") {
    throw new Error(
      `defineEndpoint(${route}): ${key}.why needs a reason — ${key === "internal" ? "who calls it, if no browser does?" : "why is the effect not predicted?"}`,
    );
  }
  return why;
}

/** A declaration's `access`, resolved: absent → `"owner"`. */
function resolveAccess(
  route: string,
  access: { public: string } | undefined,
): EndpointAccess {
  if (access === undefined) return "owner";
  // A cast past tsc (`access: "owner"`) is refused by name, not by a TypeError.
  if (typeof access !== "object" || typeof access.public !== "string") {
    throw new Error(
      `defineEndpoint(${route}): access is { public: "<reason>" } or absent (owner) — got ${JSON.stringify(access)}`,
    );
  }
  if (access.public.trim() === "") {
    // Fail loudly at declaration: the reason is the review surface of a
    // public route; an empty one hides that the route is open.
    throw new Error(
      `defineEndpoint(${route}): access.public needs a reason — why may an anonymous caller reach it?`,
    );
  }
  return { public: access.public };
}
