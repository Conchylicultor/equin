import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
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
  readonly querySchema?: ZodParser<TQuery>;
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
  | PredictedMachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>;

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
type Spec<T> = ZodParser<T> | Codec<T>;

/**
 * Extracts the payload type from a spec. Inferring `B`/`R` as the *spec object*
 * type and extracting via this conditional avoids the union-variance inference
 * regression a direct `ZodParser<T> | Codec<T>` parameter would cause (`Codec<T>`
 * is invariant in `T`).
 */
type SpecType<S> =
  S extends Codec<infer U> ? U : S extends ZodParser<infer U> ? U : void;

/** What `defineEndpoint` takes, whichever host serves it. */
interface EndpointOptions<Route extends string, B, R, TQuery> {
  route: Route;
  body?: B;
  response?: R;
  query?: ZodParser<TQuery>;
  concurrency?: number;
  dedupe?: boolean;
  slowThresholdMs?: number;
  /** A read cannot write, so a GET declaring it is a tsc error. */
  agentWrite?: Route extends `${"GET" | "HEAD" | "OPTIONS"} ${string}`
    ? never
    : AgentWrite;
  /** A read cannot write, so a GET declaring it is a tsc error. */
  agentReverted?: Route extends `${"GET" | "HEAD" | "OPTIONS"} ${string}`
    ? never
    : true;
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
 * see {@link EffectOn} for why a callback). A GET declaring one is a tsc
 * error.
 */
type EffectBuilder<Route extends string, B> = (
  on: EffectOn<ExtractParams<Route>, SpecType<B>>,
) => EndpointEffect<ExtractParams<Route>, SpecType<B>>;
type EffectOption<Route extends string, B> = {
  effect: Route extends `${"GET" | "HEAD" | "OPTIONS"} ${string}`
    ? never
    : EffectBuilder<Route, B>;
};

/**
 * Declare an endpoint. With `needsMachine: { feature }` it is desktop-only — a
 * {@link MachineEndpointDef}, whose every client handles the "not available"
 * answer (tsc); without it, a portable {@link EndpointDef}. A write declaring
 * its `effect` (built by `network/live`'s `patchRow` / `removeRow` /
 * `applyRows` / `effects`, its request callbacks typed by this route) is a
 * {@link PredictedEndpointDef} / {@link PredictedMachineEndpointDef}, sent
 * only through `useLiveMutation`.
 */
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    EffectOption<Route, B> & { needsMachine: MachineFeature },
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
    EffectOption<Route, B> & { needsMachine?: undefined },
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
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine: MachineFeature;
    effect?: undefined;
  },
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
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine?: undefined;
    effect?: undefined;
  },
): EndpointDef<Route, ExtractParams<Route>, SpecType<B>, SpecType<R>, TQuery>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine?: MachineFeature;
    effect?: EffectBuilder<Route, B>;
  },
): AnyEndpointDef<
  Route,
  ExtractParams<Route>,
  SpecType<B>,
  SpecType<R>,
  TQuery
> {
  if (opts.effect !== undefined && readMarkerOf(opts.route) !== undefined) {
    // Typed away (`effect` is `never` on a read); refused against a cast.
    throw new Error(
      `defineEndpoint(${opts.route}): \`effect\` on a read — only a write changes live data.`,
    );
  }
  const bodyCodec = opts.body
    ? isCodec(opts.body)
      ? opts.body
      : json(opts.body as ZodParser<unknown>)
    : undefined;
  const responseCodec = opts.response
    ? isCodec(opts.response)
      ? opts.response
      : json(opts.response as ZodParser<unknown>)
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
  } as AnyEndpointDef<
    Route,
    ExtractParams<Route>,
    SpecType<B>,
    SpecType<R>,
    TQuery
  >;
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
