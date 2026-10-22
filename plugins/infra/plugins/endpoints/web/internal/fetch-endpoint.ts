import {
  fetchWithRetry,
  transportScoped,
  useTransportScoped,
  type FetchWithRetryOptions,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type {
  EndpointDef,
  MachineEndpointDef,
  MachineResult,
} from "../../core";
import {
  extractMethod,
  interpolatePath,
  isAgentWriteRefusal,
  unavailableMessage,
} from "../../core";
import { AGENT_WRITE_HEADER } from "@plugins/infra/plugins/request-origin/core";
import { endpointErrorSink } from "./error-reporter";

export class EndpointError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

/**
 * Main refused the write because the request came from an agent session
 * (`agentWrite` in `endpoints/core` — main is read-only for agents). Not a bug
 * of the endpoint, nor of the caller: the message tells the agent to reproduce
 * on its own build. Nothing files it — `fetchEndpoint` skips
 * `endpointErrorSink`, the crash collector skips it as an unhandled rejection,
 * and an optimistic write's rejection is toasted but not reported — so an agent
 * clicking around main cannot raise a report storm.
 */
export class EndpointAgentWriteRefusedError extends EndpointError {}

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

export type FetchOpts<TBody, TQuery> = {
  signal?: AbortSignal;
  /** RequestInit passthrough; lets a beacon survive page unload. */
  keepalive?: boolean;
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
  // `[T] extends [void]` (tuple-wrapped) keeps the conditional non-distributive
  // so a union body type (e.g. a discriminated `BlockOp`) stays one `body: TBody`
  // requirement instead of distributing into `{body: A} | {body: B} | …`, which
  // would reject the whole-union value.
} & ([TBody] extends [void] ? { body?: never } : { body: TBody }) &
  ([TQuery] extends [void] ? { query?: never } : { query: TQuery });

/** What a request to an endpoint answers: its decoded response, `void` for none. */
type Answer<TResponse> = TResponse extends void ? void : TResponse;

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
  const method = extractMethod(endpoint.route);
  let url = interpolatePath(
    endpoint.path,
    (params ?? {}) as Record<string, string>,
  );

  // Append query params
  if (opts && "query" in opts && opts.query != null) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(
      opts.query as Record<string, unknown>,
    )) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {};
  // Advisory only (the server reads the endpoint's declaration): tells the
  // agent browser's write drain this write need not be waited for.
  if (endpoint.agentWrite !== undefined) {
    headers[AGENT_WRITE_HEADER] = endpoint.agentWrite;
  }
  // Content-type comes only from the codec — no application/json fallback, so
  // multipart stays header-less (the browser sets the boundary).
  let body: BodyInit | undefined;
  if (endpoint.bodyCodec && opts && "body" in opts && opts.body !== undefined) {
    const enc = endpoint.bodyCodec.encodeRequest(opts.body);
    body = enc.body;
    if (enc.contentType) headers["Content-Type"] = enc.contentType;
  }

  const init: RequestInit = {
    method,
    headers,
    body,
    signal: opts?.signal,
    keepalive: opts?.keepalive,
  };
  const res = opts?.retry
    ? await fetchWithRetry(url, init, { ...opts.retry, fetch: transport.fetch })
    : await transport.fetch(url, init);

  if (!res.ok) {
    // Read the body ONCE, as text, then upgrade to JSON if it parses.
    //
    // The reverse order silently destroys plain-text errors: `res.json()`
    // disturbs the body, so the `res.text()` in its catch throws "Body already
    // used" and yields null. Every `HttpError(400, "…")` in the repo — which
    // serializes as plain text — therefore arrived here as a null body and was
    // rendered as the useless "HTTP 400".
    const rawBody = await res.text().catch(() => null);
    let errorBody: unknown = rawBody;
    if (rawBody) {
      try {
        errorBody = JSON.parse(rawBody);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        // Not JSON — keep the text, which is exactly what HttpError sends.
      }
    }
    if (isAgentWriteRefusal(res.status, errorBody)) {
      throw new EndpointAgentWriteRefusedError(res.status, errorBody);
    }
    // Reported only where the subtree's telemetry is (`transport.telemetry`):
    // a scope set to drop it raises nothing for the page's server to file.
    if (opts?.report !== false && transport.telemetry) {
      endpointErrorSink.emit({
        route: endpoint.route,
        status: res.status,
        body: errorBody,
      });
    }
    throw new EndpointError(res.status, errorBody);
  }

  // void response (204 or no response codec)
  if (res.status === 204 || !endpoint.responseCodec) {
    return undefined as Answer<TResponse>;
  }

  const parsed = await endpoint.responseCodec.decodeResponse(res);
  return parsed as Answer<TResponse>;
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
