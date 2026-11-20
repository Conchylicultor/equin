import {
  EndpointError,
  endpointErrorSink,
} from "@plugins/infra/plugins/endpoints/web";
import {
  sendEndpointRequest,
  type EndpointDef,
  type EndpointRequestOpts,
  type WriteEndpoint,
} from "@plugins/infra/plugins/endpoints/core";
import type { Transport } from "@plugins/primitives/plugins/networking/web";
import { ndjsonFrames } from "../../shared/ndjson-lines";

// Async generator yielding one parsed JSON frame per line, over the caller's
// transport (`useTransport()`), so a stream inside a scoped subtree never
// reaches the page's server. The request is built from the endpoint's contract
// (params, query, body codec, method), and the contract must be a WRITE
// (`& WriteEndpoint`): a mutation streaming its progress, never a read — a GET
// def is a tsc error, and throws if a cast gets one past tsc. Guards res.ok so
// a plain-text gateway error (e.g. "backend unavailable") is surfaced +
// reported instead of crashing JSON.parse; restores crash reporting for
// streamed routes.
export async function* readNdjson<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  transport: Transport,
  endpoint: EndpointDef<Route, TParams, TBody, TResponse, TQuery> &
    WriteEndpoint,
  params: TParams,
  opts?: EndpointRequestOpts<TBody, TQuery>,
): AsyncGenerator<Record<string, unknown>> {
  if (endpoint.read !== undefined) {
    throw new Error(`${endpoint.route}: ${endpoint.read}`);
  }
  const res = await sendEndpointRequest(
    transport.fetch,
    endpoint,
    params,
    opts,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => null);
    if (transport.telemetry) {
      endpointErrorSink.emit({
        route: endpoint.route,
        status: res.status,
        body,
      });
    }
    throw new EndpointError(
      endpoint.route,
      res.status,
      body ?? `HTTP ${res.status}`,
    );
  }
  if (res.body === null) {
    throw new Error(`${endpoint.route}: the streamed response has no body`);
  }
  for await (const frame of ndjsonFrames(res.body)) {
    yield frame as Record<string, unknown>;
  }
}
