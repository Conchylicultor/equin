import { useMemo } from "react";
import {
  fetchWithRetry,
  originTransport,
  useTransport,
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
  isUnsupportedEndpointRefusal,
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
 * The host refused the endpoint as one it does not serve
 * (`unsupportedEndpointResponse` — e.g. a browser server standing in for the
 * real one). Not a failure of the endpoint: the refusing host already told
 * the user, so `fetchEndpoint` reports nothing to `endpointErrorSink` and the
 * mutation-error toast skips it.
 */
export class EndpointUnsupportedError extends EndpointError {}

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

type FetchOpts<TBody, TQuery> = {
  signal?: AbortSignal;
  /**
   * The server the request goes to — the caller's `useTransport()`. Omitted =
   * the page's own server; a component reaches its subtree's through
   * `useFetchEndpoint()` instead of passing it by hand.
   */
  transport?: Transport;
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
 * Typed fetch wrapper for endpoint definitions.
 *
 * - Interpolates params into the URL
 * - Appends query params if query schema exists
 * - JSON-serializes body for mutation methods
 * - Parses response through responseSchema if provided
 * - Throws EndpointError on non-2xx (EndpointUnsupportedError, unreported,
 *   when the host refuses the endpoint as one it does not serve)
 *
 * A desktop-only endpoint (`needsMachine`) answers a `MachineResult`: `ok` with
 * the value, or — when the transport has no computer behind it
 * (`transport.machine` false: an in-browser server) — `unavailable` with the
 * sentence to show, without making a request.
 */
export async function fetchEndpoint<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  opts?: FetchOpts<TBody, TQuery>,
): Promise<MachineResult<Answer<TResponse>>>;
export async function fetchEndpoint<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: EndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  opts?: FetchOpts<TBody, TQuery>,
): Promise<Answer<TResponse>>;
export async function fetchEndpoint<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint:
    | EndpointDef<Route, TParams, TBody, TResponse, TQuery>
    | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  opts?: FetchOpts<TBody, TQuery>,
): Promise<Answer<TResponse> | MachineResult<Answer<TResponse>>> {
  if (endpoint.needsMachine === undefined) {
    return request(endpoint, params, opts);
  }
  if (!(opts?.transport ?? originTransport).machine) {
    return {
      kind: "unavailable",
      message: unavailableMessage(endpoint.needsMachine),
    };
  }
  return { kind: "ok", value: await request(endpoint, params, opts) };
}

/** One request to an endpoint over the caller's transport, decoded. */
async function request<Route extends string, TParams, TBody, TResponse, TQuery>(
  endpoint:
    | EndpointDef<Route, TParams, TBody, TResponse, TQuery>
    | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
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
  const transport = opts?.transport ?? originTransport;
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
    if (isUnsupportedEndpointRefusal(res.status, errorBody)) {
      throw new EndpointUnsupportedError(res.status, errorBody);
    }
    if (isAgentWriteRefusal(res.status, errorBody)) {
      throw new EndpointAgentWriteRefusedError(res.status, errorBody);
    }
    if (opts?.report !== false) {
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
 * `fetchEndpoint` bound to the enclosing subtree's transport — what a
 * component calls instead of the bare function, so a request it makes inside a
 * `<TransportProvider>` (a demo backend) reaches that transport, never the
 * page's server.
 */
export function useFetchEndpoint(): typeof fetchEndpoint {
  const transport = useTransport();
  return useMemo(
    () =>
      ((
        endpoint: EndpointDef<string, unknown, unknown, unknown, unknown>,
        params: unknown,
        opts?: FetchOpts<unknown, unknown>,
      ) =>
        // Either kind of endpoint: the bare function dispatches on it.
        fetchEndpoint(endpoint, params, {
          ...opts,
          transport,
        } as typeof opts)) as typeof fetchEndpoint,
    [transport],
  );
}
