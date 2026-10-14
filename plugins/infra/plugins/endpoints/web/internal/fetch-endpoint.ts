import { useMemo } from "react";
import {
  fetchWithRetry,
  originTransport,
  useTransport,
  type FetchWithRetryOptions,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type { EndpointDef } from "../../core";
import {
  extractMethod,
  interpolatePath,
  isUnsupportedEndpointRefusal,
} from "../../core";
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

/**
 * Typed fetch wrapper for endpoint definitions.
 *
 * - Interpolates params into the URL
 * - Appends query params if query schema exists
 * - JSON-serializes body for mutation methods
 * - Parses response through responseSchema if provided
 * - Throws EndpointError on non-2xx (EndpointUnsupportedError, unreported,
 *   when the host refuses the endpoint as one it does not serve)
 */
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
): Promise<TResponse extends void ? void : TResponse> {
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
    return undefined as TResponse extends void ? void : TResponse;
  }

  const parsed = await endpoint.responseCodec.decodeResponse(res);
  return parsed as TResponse extends void ? void : TResponse;
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
      ((endpoint, params, opts) =>
        fetchEndpoint(endpoint, params, {
          ...opts,
          transport,
        } as typeof opts)) as typeof fetchEndpoint,
    [transport],
  );
}
