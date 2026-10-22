import {
  recordEntrySpan,
  chargeWait,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import type {
  EndpointHttpHandler,
  HttpHandler,
} from "@plugins/framework/plugins/server-core/core";
import type { EndpointDef, MachineEndpointDef } from "./define-endpoint";
import { agentWriteGate, type AgentWrite } from "./agent-write";
import { registerRouteSlowThreshold } from "./slow-threshold";
import { HttpError } from "./http-error";

export { HttpError };

// Widen string types recursively so handlers can return:
// - Drizzle `timestamp` columns (Date) where the Zod schema says string
// - Rank class objects where the schema says string (toJSON serialises them)
// - Plain strings where the schema infers a branded string
// Response.json() serialises all of these correctly on the wire.
type JsonSerializable = { toJSON(): string; toString(): string };
type JsonCompat<T> = T extends string
  ? string | Date | JsonSerializable
  : T extends Blob | ArrayBuffer | ArrayBufferView | FormData | ReadableStream
    ? T
    : T extends (infer U)[]
      ? JsonCompat<U>[]
      : T extends object
        ? { [K in keyof T]: JsonCompat<T[K]> }
        : T;

/** What an endpoint's handler is given, and may answer. */
export type EndpointHandler<TParams, TBody, TResponse, TQuery> = (ctx: {
  params: TParams;
  body: TBody;
  query: TQuery;
  req: Request;
}) => Promise<JsonCompat<TResponse>> | JsonCompat<TResponse>;

/**
 * The server handler for a portable endpoint. A desktop-only one
 * (`needsMachine`) is a tsc error here: it is implemented by `implementMachine`
 * (`endpoints/machine`), whose handler only a plugin's `machine/` half serves.
 */
export function implement<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: EndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  handler: EndpointHandler<TParams, TBody, TResponse, TQuery>,
): EndpointHttpHandler {
  return endpointHandler(endpoint, handler);
}

/**
 * `implement`'s body, for either kind of endpoint: the one place a request is
 * decoded, gated and answered — `implementMachine` brands its result, nothing
 * else differs.
 */
export function endpointHandler<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  _endpoint:
    | EndpointDef<Route, TParams, TBody, TResponse, TQuery>
    | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  handler: EndpointHandler<TParams, TBody, TResponse, TQuery>,
): EndpointHttpHandler {
  // Per-route gates, built once at registration. `concurrency` caps how many
  // handler bodies run at once (e.g. routes that spawn git/tar subprocesses, so
  // a burst can't saturate the box); `dedupe` collapses concurrent identical
  // GETs onto one in-flight handler. See
  // research/2026-06-15-global-live-state-cascade-contention.md (Change 5).
  const gate = _endpoint.concurrency
    ? createSemaphore(_endpoint.concurrency)
    : null;
  const dedupe = _endpoint.dedupe ? createInflight() : null;
  if (dedupe && _endpoint.method !== "GET") {
    // Fail loudly at boot: deduping a mutation would silently drop a caller's
    // distinct side effect.
    throw new Error(
      `implement(${_endpoint.route}): dedupe is only valid on GET endpoints`,
    );
  }
  // Publish the per-route slow-op threshold so the slow-ops pipeline can hold this
  // route to a tighter bar than the global `httpMs` default (see slow-threshold).
  if (_endpoint.slowThresholdMs != null) {
    registerRouteSlowThreshold(_endpoint.route, _endpoint.slowThresholdMs);
  }
  // Main is read-only for agent sessions: refused before the body is even
  // decoded. `null` (decided once) everywhere it cannot refuse.
  const agentGate = agentWriteGate(_endpoint);
  return brand(async (req: Request, params: Record<string, string>) => {
    if (agentGate) {
      const refused = agentGate(req);
      if (refused) return refused;
    }
    try {
      // Decode body via codec if one exists. The codec throws HttpError(400)
      // on a bad payload, handled by the catch below.
      let body: TBody = undefined as TBody;
      if (_endpoint.bodyCodec) {
        body = await _endpoint.bodyCodec.decodeRequest(req);
      }

      // Parse query if schema exists
      let query: TQuery = undefined as TQuery;
      if (_endpoint.querySchema) {
        const url = new URL(req.url, "http://localhost");
        const raw: Record<string, string> = {};
        for (const [key, value] of url.searchParams.entries()) {
          raw[key] = value;
        }
        const result = _endpoint.querySchema.safeParse(raw);
        if (!result.success) {
          return Response.json(
            { error: "Query validation failed", issues: result.error.issues },
            { status: 400 },
          );
        }
        query = result.data;
      }

      // Records an `http` span and establishes the ambient parent context so
      // nested DB/loader spans attribute to this route. The entry span
      // ENCLOSES the gates — dedupe (outermost, so duplicates never even take
      // a concurrency slot) → concurrency gate → handler — so the http span's
      // wall matches client-observed latency and queue-wait is attributed to
      // it by name (`endpoint-dedupe` / `endpoint-concurrency` waits) instead
      // of hiding outside the span. Deduped callers share one `result` object
      // (read-only JSON-safe data) and each encodes its own Response below.
      // Records in `finally`, so a throwing handler's duration is captured too.
      const result = await recordEntrySpan(
        "http",
        _endpoint.route,
        async () => {
          const runHandler = async (): Promise<JsonCompat<TResponse>> =>
            handler({
              params: params as TParams,
              body,
              query,
              req,
            });
          const gated = gate
            ? () =>
                gate.run(runHandler, {
                  onWait: (ms) => chargeWait("endpoint-concurrency", ms),
                })
            : runHandler;
          return dedupe
            ? dedupe.run(dedupeKey(req), gated, {
                onWait: (ms) => chargeWait("endpoint-dedupe", ms),
              })
            : gated();
        },
      );

      // void/undefined → 204. `null` is a value (a `.nullable()` response),
      // not an absence: it goes out as JSON `null` so the client decodes it
      // through the response schema — a 204 reads back as `undefined`.
      if (result === undefined) {
        return new Response(null, { status: 204 });
      }

      return _endpoint.responseCodec
        ? _endpoint.responseCodec.encodeResponse(result as TResponse)
        : Response.json(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(err.message, { status: err.status });
      }
      throw err;
    }
  });
}

/**
 * A RAW write handler (`(req, params) => Response`) behind its endpoint's
 * declaration: for a route whose answer `implement` cannot build (a binary or
 * streamed body, custom headers or status) but which may still write. It runs
 * the same agent-write gate first — the reason a write route takes only an
 * `EndpointHttpHandler` (server-core's `HttpRoutes`) — and nothing else:
 * decoding is the handler's.
 */
export function rawEndpointHandler(
  endpoint: { route: string; method: string; agentWrite?: AgentWrite },
  handler: HttpHandler,
): EndpointHttpHandler {
  const agentGate = agentWriteGate(endpoint);
  if (!agentGate) return brand(handler);
  return brand((req, params) => agentGate(req) ?? handler(req, params));
}

// The brand is type-only: an endpoint handler IS a handler. Minted here alone.
function brand(handler: HttpHandler): EndpointHttpHandler {
  return handler as EndpointHttpHandler;
}

// Identity of a GET for dedup: method + path + query string. Two requests with
// the same key request the same bytes, so they can share one handler run.
function dedupeKey(req: Request): string {
  const url = new URL(req.url, "http://localhost");
  return `${req.method} ${url.pathname}${url.search}`;
}
