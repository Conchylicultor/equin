import type {
  HttpHandler,
  MachineHttpHandler,
} from "@plugins/framework/plugins/server-core/core";
import type { MachineEndpointDef } from "../../core/define-endpoint";
import { endpointHandler, type EndpointHandler } from "../../core/implement";

/**
 * The server handler for a desktop-only endpoint (`needsMachine`): the same
 * request handling as `implement`, branded `MachineHttpHandler` — the only
 * handler a `machine/` barrel's `httpRoutes` accepts, and one no `server/`
 * barrel's accepts. A portable endpoint is a tsc error here, so machine code
 * alone can never serve one (a silent 404 on every host without the computer).
 */
export function implementMachine<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  handler: EndpointHandler<TParams, TBody, TResponse, TQuery>,
): MachineHttpHandler {
  // The brand is type-only: a machine handler IS a handler.
  return endpointHandler(endpoint, handler) as MachineHttpHandler;
}

/**
 * A RAW handler (`(req, params) => Response`) a `machine/` barrel serves: for a
 * route with no typed contract — a binary or streamed answer, a harness that
 * returns its own status — whose code needs the computer. Brands it
 * `MachineHttpHandler`, the only handler a machine barrel's `httpRoutes` take.
 * A route a client calls through a typed endpoint is `implementMachine`'s, so
 * its callers get the unavailable arm; this one has no client contract to give.
 */
export function machineHandler(handler: HttpHandler): MachineHttpHandler {
  // The brand is type-only: a machine handler IS a handler.
  return handler as MachineHttpHandler;
}
