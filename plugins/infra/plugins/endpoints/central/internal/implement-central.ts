import type { EndpointHttpHandler } from "@plugins/framework/plugins/server-core/core";
import type { MachineEndpointDef } from "../../core/define-endpoint";
import { endpointHandler, type EndpointHandler } from "../../core/implement";

/**
 * Central's handler for an endpoint declared `needsMachine`: central runs
 * only on the computer, so it serves what a host without the computer answers
 * "not available" (the accounts a page connects). A portable endpoint central
 * serves still goes through `implement`.
 */
export function implementCentral<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  handler: EndpointHandler<TParams, TBody, TResponse, TQuery>,
): EndpointHttpHandler {
  return endpointHandler(endpoint, handler);
}
