import { AGENT_WRITE_HEADER } from "@plugins/infra/plugins/request-origin/core";
import type { EndpointDef, MachineEndpointDef } from "./define-endpoint";
import {
  EndpointAgentWriteRefusedError,
  EndpointError,
} from "./endpoint-error";
import { isAgentWriteRefusal } from "./agent-write";
import { interpolatePath } from "./route-params";

/** Either kind of endpoint — a request is built and read the same way. */
type AnyEndpointDef<Route extends string, TParams, TBody, TResponse, TQuery> =
  | EndpointDef<Route, TParams, TBody, TResponse, TQuery>
  | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>;

/**
 * What a request to an endpoint carries beyond its params: the body and query
 * its contract declares (required when declared, refused when not), plus
 * transport passthroughs.
 */
export type EndpointRequestOpts<TBody, TQuery> = {
  signal?: AbortSignal;
  /** RequestInit passthrough; lets a beacon survive page unload. */
  keepalive?: boolean;
  /** Extra request headers (e.g. a caller's agent-origin provenance). */
  headers?: Record<string, string>;
  // `[T] extends [void]` (tuple-wrapped) keeps the conditional non-distributive
  // so a union body type (e.g. a discriminated `BlockOp`) stays one `body: TBody`
  // requirement instead of distributing into `{body: A} | {body: B} | …`, which
  // would reject the whole-union value.
} & ([TBody] extends [void] ? { body?: never } : { body: TBody }) &
  ([TQuery] extends [void] ? { query?: never } : { query: TQuery });

/** What a request to an endpoint answers: its decoded response, `void` for none. */
export type EndpointAnswer<TResponse> = TResponse extends void
  ? void
  : TResponse;

/**
 * An endpoint's path, built from its contract: the route's params interpolated
 * (typed by the route) and the query appended. For a URL handed to someone
 * else rather than fetched here — an agent's MCP URL, a link — so it cannot
 * drift from the route either.
 */
export function endpointPath<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: AnyEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  query?: TQuery,
): string {
  let path = interpolatePath(
    endpoint.path,
    (params ?? {}) as Record<string, string>,
  );
  if (query != null) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(
      query as Record<string, unknown>,
    )) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) path += `?${qs}`;
  }
  return path;
}

/**
 * One request to an endpoint, built from its contract: the path with params
 * interpolated and the query appended, and the init — the route's method, the
 * body through its codec (content type from the codec only, so multipart stays
 * header-less), the advisory `AGENT_WRITE_HEADER` for a declaring endpoint.
 */
export function endpointRequest<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: AnyEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  opts?: EndpointRequestOpts<TBody, TQuery>,
): { path: string; init: RequestInit } {
  const path = endpointPath(
    endpoint,
    params,
    opts && "query" in opts ? (opts.query as TQuery) : undefined,
  );

  const headers: Record<string, string> = { ...opts?.headers };
  // Advisory only (the server reads the endpoint's declaration): tells the
  // agent browser's write drain this write need not be waited for.
  if (endpoint.agentWrite !== undefined) {
    headers[AGENT_WRITE_HEADER] = endpoint.agentWrite;
  }
  let body: BodyInit | undefined;
  if (endpoint.bodyCodec && opts && "body" in opts && opts.body !== undefined) {
    const enc = endpoint.bodyCodec.encodeRequest(opts.body);
    body = enc.body;
    if (enc.contentType) headers["Content-Type"] = enc.contentType;
  }

  return {
    path,
    init: {
      method: endpoint.method,
      headers,
      body,
      signal: opts?.signal,
      keepalive: opts?.keepalive,
    },
  };
}

/**
 * An endpoint's reply, read through its contract: a non-2xx throws
 * `EndpointError` (refined to `EndpointAgentWriteRefusedError` for main's
 * agent-write refusal), carrying the body —
 * JSON when it parses, else its text; a 2xx decodes through the response
 * codec, `void` for a 204 or an endpoint declaring no response.
 */
export async function readEndpointResponse<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: AnyEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  res: Response,
  /** The error message for a non-2xx; omitted = `HTTP <status>`. */
  describe?: (status: number, rawBody: string | null) => string,
): Promise<EndpointAnswer<TResponse>> {
  if (!res.ok) {
    // Read the body ONCE, as text, then upgrade to JSON if it parses.
    //
    // The reverse order silently destroys plain-text errors: `res.json()`
    // disturbs the body, so a `res.text()` in its catch throws "Body already
    // used" — and every `HttpError(400, "…")`, which serializes as plain text,
    // would arrive as a null body.
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
    const message = describe?.(res.status, rawBody);
    if (isAgentWriteRefusal(res.status, errorBody)) {
      throw new EndpointAgentWriteRefusedError(res.status, errorBody, message);
    }
    throw new EndpointError(res.status, errorBody, message);
  }

  if (res.status === 204 || !endpoint.responseCodec) {
    return undefined as EndpointAnswer<TResponse>;
  }
  return (await endpoint.responseCodec.decodeResponse(
    res,
  )) as EndpointAnswer<TResponse>;
}
