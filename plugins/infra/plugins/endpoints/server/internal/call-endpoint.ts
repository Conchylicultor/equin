import type {
  EndpointAnswer,
  EndpointDef,
  EndpointRequestOpts,
  MachineEndpointDef,
} from "../../core";
import { endpointRequest, readEndpointResponse } from "../../core";

type CallOpts<TBody, TQuery> = EndpointRequestOpts<TBody, TQuery> & {
  /**
   * The server the request goes to, absolute and without a trailing slash:
   * `http://localhost:9000` for central's routes (the gateway serves them on
   * every host name), `namespaceUrl(ns)` for one backend.
   */
  origin: string;
};

/**
 * Call an endpoint from code that is not a page (a backend, a machine half,
 * the CLI, a launcher): `useFetchEndpoint`'s twin over the global `fetch` and
 * an absolute origin. Params, body, query and the answer all come from the
 * endpoint's contract, so a contract change is a tsc error here rather than a
 * misread reply at runtime. Server-side only: a page reaches a server through
 * its subtree's transport, never a URL.
 *
 * A request that got no answer throws fetch's own `TypeError`; a non-2xx an
 * `EndpointError` (`readEndpointResponse`) whose message names the request and
 * the reply. Retry and offline policy are the caller's, expressed over those
 * two.
 */
export async function callEndpoint<
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
  opts: CallOpts<TBody, TQuery>,
): Promise<EndpointAnswer<TResponse>> {
  const { path, init } = endpointRequest(endpoint, params, opts);
  const url = `${opts.origin}${path}`;
  const res = await fetch(url, init);
  return readEndpointResponse(
    endpoint,
    res,
    (status, rawBody) =>
      `${endpoint.method} ${url}: HTTP ${status}${rawBody ? ` ${rawBody.slice(0, 500)}` : ""}`,
  );
}
