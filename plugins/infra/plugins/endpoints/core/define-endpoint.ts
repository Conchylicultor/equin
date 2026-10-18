import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { type Codec, isCodec, json } from "./codec";
import type { ExtractParams } from "./route-params";
import { extractMethod, extractPath } from "./route-params";
import type { MachineFeature } from "./needs-machine";

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
}

/**
 * Declare an endpoint. With `needsMachine: { feature }` it is desktop-only — a
 * {@link MachineEndpointDef}, whose every client handles the "not available"
 * answer (tsc); without it, a portable {@link EndpointDef}.
 */
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> & { needsMachine: MachineFeature },
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
  opts: EndpointOptions<Route, B, R, TQuery> & { needsMachine?: undefined },
): EndpointDef<Route, ExtractParams<Route>, SpecType<B>, SpecType<R>, TQuery>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine?: MachineFeature;
  },
):
  | EndpointDef<Route, ExtractParams<Route>, SpecType<B>, SpecType<R>, TQuery>
  | MachineEndpointDef<
      Route,
      ExtractParams<Route>,
      SpecType<B>,
      SpecType<R>,
      TQuery
    > {
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
    bodyCodec: bodyCodec as Codec<SpecType<B>> | undefined,
    responseCodec: responseCodec as Codec<SpecType<R>> | undefined,
    querySchema: opts.query,
    concurrency: opts.concurrency,
    dedupe: opts.dedupe,
    slowThresholdMs: opts.slowThresholdMs,
    ...(opts.needsMachine !== undefined
      ? { needsMachine: opts.needsMachine }
      : {}),
  };
}
