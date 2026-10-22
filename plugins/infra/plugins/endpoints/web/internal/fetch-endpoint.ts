import {
  fetchWithRetry,
  transportScoped,
  useTransportScoped,
  type FetchWithRetryOptions,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type {
  EndpointAnswer,
  EndpointDef,
  EndpointRequestOpts,
  MachineEndpointDef,
  MachineResult,
} from "../../core";
import {
  EndpointAgentWriteRefusedError,
  EndpointError,
  endpointRequest,
  readEndpointResponse,
  unavailableMessage,
} from "../../core";
import { endpointErrorSink } from "./error-reporter";

export function getEndpointErrorMessage(error: unknown): string {
  if (error instanceof EndpointError) {
    const { body } = error;
    // `HttpError` serializes as `new Response(err.message)` — plain text — and
    // `fetchEndpoint` falls back to `res.text()`, so its message arrives here
    // as a string. Without this branch every one of those messages was
    // discarded in favour of `EndpointError`'s hardcoded `HTTP <status>`.
    if (typeof body === "string" && body.trim()) return body;
    if (
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof (body as { message: unknown }).message === "string"
    ) {
      return (body as { message: string }).message;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export type FetchOpts<TBody, TQuery> = EndpointRequestOpts<TBody, TQuery> & {
  /** Default true. `false` skips endpointErrorSink.emit (e.g. the crash beacon). */
  report?: boolean;
  /**
   * Opt-in: send through `fetchWithRetry` — bounded exponential backoff over a
   * network error or a `retryOn` status (default 502/503/504, what a backend
   * restart answers; a 4xx is never retried by default). The final attempt's
   * response goes through the usual non-2xx handling below. Off by
   * default: a retried request can land twice, so only an idempotent call (or
   * one the server dedupes) should ask for it.
   */
  retry?: FetchWithRetryOptions;
};

type Answer<TResponse> = EndpointAnswer<TResponse>;

/**
 * The typed endpoint client, bound to ONE transport — there is no
 * transportless fetcher. A component gets its subtree's with
 * `useFetchEndpoint()`; a helper takes one from its caller as a parameter
 * named `fetchEndpoint` (the call-name lints read that name, and
 * `endpoints/fetch-endpoint-binding-name` keeps every binding of it so);
 * sanctioned page-level code binds `fetchEndpointOver(pageTransport)`.
 *
 * - Interpolates params into the URL
 * - Appends query params if query schema exists
 * - Encodes the body through the endpoint's codec
 * - Decodes the response through the endpoint's codec
 * - Throws EndpointError on non-2xx — reported to `endpointErrorSink`, a
 *   host's unsupported refusal (`unsupportedEndpointResponse`) included: under
 *   a browser host the coverage guard proves every endpoint the page calls is
 *   served or `needsMachine` (answered `unavailable` without a request), so a
 *   refusal is a gap the guard missed — a bug, never a state to hide
 *
 * A desktop-only endpoint (`needsMachine`) answers a `MachineResult`: `ok` with
 * the value, or — when the transport has no computer behind it
 * (`transport.machine` false: an in-browser server) — `unavailable` with the
 * sentence to show, without making a request.
 */
export interface FetchEndpoint {
  <Route extends string, TParams, TBody, TResponse, TQuery>(
    endpoint: MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
    params: TParams,
    opts?: FetchOpts<TBody, TQuery>,
  ): Promise<MachineResult<Answer<TResponse>>>;
  <Route extends string, TParams, TBody, TResponse, TQuery>(
    endpoint: EndpointDef<Route, TParams, TBody, TResponse, TQuery>,
    params: TParams,
    opts?: FetchOpts<TBody, TQuery>,
  ): Promise<Answer<TResponse>>;
}

/** Either kind of endpoint, as the internal dispatch sees it. */
type AnyEndpoint<Route extends string, TParams, TBody, TResponse, TQuery> =
  | EndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>;

/** One call over `transport`, dispatched on the endpoint's kind. */
async function call<Route extends string, TParams, TBody, TResponse, TQuery>(
  transport: Transport,
  endpoint: AnyEndpoint<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  opts?: FetchOpts<TBody, TQuery>,
): Promise<Answer<TResponse> | MachineResult<Answer<TResponse>>> {
  if (endpoint.needsMachine === undefined) {
    return request(transport, endpoint, params, opts);
  }
  if (!transport.machine) {
    return {
      kind: "unavailable",
      message: unavailableMessage(endpoint.needsMachine),
    };
  }
  return {
    kind: "ok",
    value: await request(transport, endpoint, params, opts),
  };
}

/** One request to an endpoint over `transport`, decoded. */
async function request<Route extends string, TParams, TBody, TResponse, TQuery>(
  transport: Transport,
  endpoint: AnyEndpoint<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  opts?: FetchOpts<TBody, TQuery>,
): Promise<Answer<TResponse>> {
  const { path, init } = endpointRequest(endpoint, params, opts);
  const res = opts?.retry
    ? await fetchWithRetry(path, init, {
        ...opts.retry,
        fetch: transport.fetch,
      })
    : await transport.fetch(path, init);

  try {
    return await readEndpointResponse(endpoint, res);
  } catch (err) {
    // Reported only where the subtree's telemetry is (`transport.telemetry`):
    // a scope set to drop it raises nothing for the page's server to file.
    if (
      err instanceof EndpointError &&
      !(err instanceof EndpointAgentWriteRefusedError) &&
      opts?.report !== false &&
      transport.telemetry
    ) {
      endpointErrorSink.emit({
        route: endpoint.route,
        status: err.status,
        body: err.body,
      });
    }
    throw err;
  }
}

/**
 * The fetcher a fake transport answers with (`web/testing`'s
 * `fakeFetchEndpoint`), registered before the transport is first used. Internal
 * to this plugin: production transports never appear here.
 */
const fakeFetchers = new WeakMap<Transport, FetchEndpoint>();

/** @internal — `web/testing` only. */
export function installFakeFetcher(
  transport: Transport,
  fetchEndpoint: FetchEndpoint,
): void {
  fakeFetchers.set(transport, fetchEndpoint);
}

/** One fetcher per transport, so a bound fetcher's identity is stable. */
const fetchers = transportScoped<FetchEndpoint>(
  (transport) =>
    fakeFetchers.get(transport) ??
    (((
      endpoint: AnyEndpoint<string, unknown, unknown, unknown, unknown>,
      params: unknown,
      opts?: FetchOpts<unknown, unknown>,
    ) => call(transport, endpoint, params, opts)) as FetchEndpoint),
);

/**
 * The fetcher over an explicit transport — for page-level code that is
 * sanctioned to name one (`fetchEndpointOver(pageTransport)`, under a
 * `networking/no-page-transport` exemption) and for a store holding the
 * transport it was made for. Bind it as `const fetchEndpoint = …`.
 */
export function fetchEndpointOver(transport: Transport): FetchEndpoint {
  return fetchers.of(transport);
}

/**
 * The fetcher of the enclosing subtree's transport — what a component or hook
 * calls (`const fetchEndpoint = useFetchEndpoint()`), so a request it makes
 * inside a `<TransportProvider>` (a demo backend) reaches that transport, never
 * the page's server. Stable per transport.
 */
export function useFetchEndpoint(): FetchEndpoint {
  return useTransportScoped(fetchers);
}
