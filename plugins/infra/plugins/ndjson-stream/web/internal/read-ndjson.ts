import {
  EndpointError,
  endpointErrorSink,
} from "@plugins/infra/plugins/endpoints/web";
import {
  endpointRequest,
  type EndpointDef,
  type EndpointRequestOpts,
  type WriteEndpoint,
} from "@plugins/infra/plugins/endpoints/core";
import type { Transport } from "@plugins/primitives/plugins/networking/web";

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
  const { path, init } = endpointRequest(endpoint, params, opts);
  const res = await transport.fetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => null);
    if (transport.telemetry) {
      endpointErrorSink.emit({
        route: endpoint.route,
        status: res.status,
        body,
      });
    }
    throw new EndpointError(res.status, body ?? `HTTP ${res.status}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}
