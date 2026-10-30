import type { z } from "zod";
import { type Codec, isCodec, json } from "./codec";
import type { ExtractParams } from "./route-params";
import { extractMethod, extractPath } from "./route-params";
import type { MachineFeature } from "./needs-machine";
import type { AgentWrite } from "./agent-write";
import type { EndpointAccess } from "@plugins/framework/plugins/principal/core";

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
 * A write no browser calls (`internal: { why }`): a server → central RPC, an
 * e2e or CLI hook. `why` is required and non-empty. The definition is an
 * {@link InternalEndpointDef}, which the browser's clients refuse (tsc).
 */
export type InternalDecl = { why: string };

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
  /** Browser-callable: an {@link InternalEndpointDef} is not one (see there). */
  readonly internal?: undefined;
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
  /** Browser-callable: an {@link InternalMachineEndpointDef} is not one. */
  readonly internal?: undefined;
}

/**
 * A portable WRITE endpoint no browser calls (`defineEndpoint({ …, internal:
 * { why } })`): a server → central RPC, a CLI or e2e hook. The browser's
 * clients — `FetchEndpoint`, `useEndpointMutation`, `readNdjson` — refuse it
 * (tsc: their defs say `internal?: undefined`). `implement` serves it,
 * `callEndpoint` and e2e flows call it.
 */
export interface InternalEndpointDef<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
> extends EndpointContract<Route, TParams, TBody, TResponse, TQuery> {
  readonly needsMachine?: undefined;
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
  | InternalEndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | InternalMachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>;

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
   *
   * `{ content: "<reason>", item: "<param>" }` (a GET only) serves untrusted
   * content — a page that runs script but is not reviewed app code — and ONLY
   * on the content host (`<item>.content.localhost`), never on an app origin.
   * `item` names the route param whose value is the content's origin key. Its
   * HTML documents carry the frame agent; framed with `ContentFrame`
   * (`primitives/embed/frame`) through `contentPath`.
   */
  access?: Route extends `GET ${string}`
    ? { public: string } | ContentAccess<Route>
    : { public: string };
}

/** `access: { content }` — see {@link EndpointOptions.access}. */
type ContentAccess<Route extends string> = {
  content: string;
  item: keyof ExtractParams<Route> & string;
};

/** `T` on a write route, `never` on a read (a GET declaring it is a tsc error). */
type OnWrite<Route extends string, T> = Route extends ReadRoute ? never : T;

/** The keys only a write may declare. */
type WriteOptions<Route extends string> = {
  /** See {@link AgentWrite}. */
  agentWrite?: OnWrite<Route, AgentWrite>;
};

/**
 * Declare an endpoint. With `needsMachine: { feature }` it is desktop-only (a
 * `Machine…Def`, whose every client handles the "not available" answer —
 * tsc); without it, portable. A write with `internal: { why }` has no browser
 * client (an `Internal…Def`).
 */
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> &
    WriteOptions<Route> & {
      internal: OnWrite<Route, InternalDecl>;
      needsMachine: MachineFeature;
    },
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
    WriteOptions<Route> & {
      internal: OnWrite<Route, InternalDecl>;
      needsMachine?: undefined;
    },
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
    WriteOptions<Route> & {
      internal?: undefined;
      needsMachine: MachineFeature;
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
  opts: EndpointOptions<Route, B, R, TQuery> &
    WriteOptions<Route> & { internal?: undefined; needsMachine?: undefined },
): EndpointDef<Route, ExtractParams<Route>, SpecType<B>, SpecType<R>, TQuery>;
export function defineEndpoint<
  const Route extends string,
  B extends Spec<unknown> = Spec<void>,
  R extends Spec<unknown> = Spec<void>,
  TQuery = void,
>(
  opts: EndpointOptions<Route, B, R, TQuery> & {
    needsMachine?: MachineFeature;
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
  const internal = resolveInternal(opts);
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
    ...(internal !== undefined ? { internal } : {}),
  } as AnyEndpointDef<
    Route,
    ExtractParams<Route>,
    SpecType<B>,
    SpecType<R>,
    TQuery
  >;
}

/**
 * A declaration's `internal`, validated — the runtime backstop of what tsc
 * refuses (a read declaring it), plus the non-empty `why`.
 */
function resolveInternal(opts: {
  route: string;
  internal?: unknown;
}): InternalDecl | undefined {
  const { route, internal } = opts;
  if (internal === undefined) return undefined;
  if (readMarkerOf(route) !== undefined) {
    throw new Error(
      `defineEndpoint(${route}): \`internal\` on a read — only a write declares it.`,
    );
  }
  const why =
    typeof internal === "object" && internal !== null
      ? (internal as { why?: unknown }).why
      : undefined;
  if (typeof why !== "string" || why.trim() === "") {
    throw new Error(
      `defineEndpoint(${route}): internal.why needs a reason — who calls it, if no browser does?`,
    );
  }
  return { why };
}

/** A declaration's `access`, resolved: absent → `"owner"`. */
function resolveAccess(
  route: string,
  access: { public: string } | { content: string; item: string } | undefined,
): EndpointAccess {
  if (access === undefined) return "owner";
  if (typeof access === "object" && "content" in access) {
    if (typeof access.content !== "string" || access.content.trim() === "") {
      throw new Error(
        `defineEndpoint(${route}): access.content needs a reason — what untrusted content does it serve?`,
      );
    }
    if (!route.startsWith("GET ") || !route.includes(`/:${access.item}`)) {
      throw new Error(
        `defineEndpoint(${route}): access.content is for a GET whose item "${access.item}" is one of its params`,
      );
    }
    return { content: access.content, item: access.item };
  }
  // A cast past tsc (`access: "owner"`) is refused by name, not by a TypeError.
  if (typeof access !== "object" || typeof access.public !== "string") {
    throw new Error(
      `defineEndpoint(${route}): access is { public: "<reason>" }, { content, item } or absent (owner) — got ${JSON.stringify(access)}`,
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
